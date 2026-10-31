import { extractTweetId, isTwitterUrl, prisma } from "@starlight/utils";
import { Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Composer, GrammyError, InlineKeyboard, InlineQueryResultBuilder, InputFile } from "grammy";
import env from "@/env";
import sharp from "sharp";
import type { FxEmbedTweet, FxEmbedVideo } from "@/services/fxembed/types";
import { renderTweetImage } from "@/services/render";
import type { RenderResult, TweetData } from "@/services/render";
import { generateTweetImage, prepareTweetData, TWEET_IMAGE_CACHE_PREFIX } from "@/services/tweet/tweet-image.service";
import type { Theme } from "@/services/tweet/tweet-image.service";
import { runtime } from "@/services/runtime";
import { TweetRichMessage } from "@/services/tweet/tweet-rich-message";
import { TwitterApi } from "@/services/twitter-api";
import { s3 } from "@/storage";
import type { Context } from "@/types";

const composer = new Composer<Context>();
const chats = composer.chatType(["private", "group", "supergroup"]);

const TWEET_NOT_FOUND_MESSAGE = "Tweet not found";

const IMAGE_JPEG_TYPE = "image/jpeg";
const THUMBNAIL_WIDTH = 320;
const TWEET_TRANSLATION_LANGUAGE = "en";

// Telegram's limits for files it downloads from a URL; grammY documents 1 MB for mpeg4_gif results.
const MPEG4_GIF_URL_LIMIT_BYTES = 1024 * 1024;
const VIDEO_URL_LIMIT_BYTES = 20 * 1024 * 1024;
const VIDEO_HEAD_TIMEOUT_MS = 3000;

const ContentLengthResponse = Schema.Struct({
  headers: Schema.Struct({ "content-length": Schema.FiniteFromString }),
});

function createThemeKeyboard(tweetId: string, currentTheme: Theme, userId: number): InlineKeyboard {
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  const buttonText = currentTheme === "dark" ? "☀️ Change theme" : "🌙 Change theme";

  return new InlineKeyboard().text(buttonText, `tweet_img:toggle:${tweetId}:${nextTheme}:${userId}`);
}

chats
  .command("quote")
  .filter((ctx) => ctx.match.trim() !== "" && extractTweetId(ctx.match.trim()) === null)
  .use(async (ctx) => {
    ctx.logger.debug({ userId: ctx.from.id, input: ctx.match.trim() }, "Invalid tweet URL provided");
    await ctx.reply("Please provide a valid tweet link");
  });

chats
  .command("quote")
  .filter((ctx) => extractTweetId(ctx.match.trim()) !== null)
  .use(async (ctx) => {
    const tweetId = extractTweetId(ctx.match.trim())!;

    ctx.logger.info({ userId: ctx.from.id, tweetId }, "Processing /q command");

    await ctx.replyWithChatAction("upload_photo");

    try {
      const result = await runtime.runPromise(generateTweetImage(tweetId, "light"));

      ctx.logger.debug({ tweetId }, "Tweet image generated successfully");

      await ctx.replyWithPhoto(new InputFile(result.buffer, `tweet-${tweetId}.jpg`), {
        caption: `https://x.com/i/status/${tweetId}`,
        reply_markup: createThemeKeyboard(tweetId, "light", ctx.from.id),
        message_thread_id: ctx.msg.message_thread_id,
      });

      try {
        await ctx.deleteMessage();
      } catch (error) {
        if (error instanceof GrammyError) {
          ctx.logger.debug({ error: error.message }, "Could not delete user message (missing permissions)");
        } else {
          throw error;
        }
      }
    } catch (error) {
      ctx.logger.error({ error, tweetId }, "Failed to generate tweet image");

      if (error instanceof Error && error.message === TWEET_NOT_FOUND_MESSAGE) {
        await ctx.reply(
          "Could not fetch this tweet. It may be:\n" +
            "• Private or from a protected account\n" +
            "• Deleted\n" +
            "• Invalid URL",
        );

        return;
      }

      await ctx.reply(
        error instanceof GrammyError
          ? "Failed to send image. Please try again."
          : "Something went wrong. Please try again later.",
      );
    }
  });

composer
  .on("inline_query")
  .filter((ctx) => isTwitterUrl(ctx.inlineQuery.query.trim()))
  .use(async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const tweetId = extractTweetId(query);

    ctx.logger.info({ userId: ctx.from.id, query, tweetId }, "Processing inline query for tweet");

    if (tweetId === null || tweetId === "") {
      ctx.logger.debug({ query }, "Failed to extract tweet ID from inline query");
      await ctx.answerInlineQuery([]);

      return;
    }

    try {
      const tweet = await runtime.runPromise(TwitterApi.getFxTweet(tweetId, TWEET_TRANSLATION_LANGUAGE));
      const tweetData = await runtime.runPromise(prepareTweetData(tweetId, tweet ?? undefined));
      const video = tweet?.media?.videos?.at(0);

      const [videoResult, lightResult, darkResult] = await Promise.all([
        video === undefined ? null : buildInlineVideoResult(tweet!, video, tweetData.replyChain ?? []),
        renderTweetImage(tweetData, "light"),
        renderTweetImage(tweetData, "dark"),
      ]);

      const results = [
        ...(videoResult === null ? [] : [videoResult]),
        ...(await Promise.all([
          uploadInlinePhoto(tweetId, "light", lightResult),
          uploadInlinePhoto(tweetId, "dark", darkResult),
        ])),
      ];

      const generatedImages = [
        {
          height: lightResult.height,
          sizeBytes: lightResult.buffer.length,
          theme: "light",
          width: lightResult.width,
        },
        {
          height: darkResult.height,
          sizeBytes: darkResult.buffer.length,
          theme: "dark",
          width: darkResult.width,
        },
      ];

      if ((tweetData.replyChain?.length ?? 0) !== 0) {
        const tweetDataWithoutChain = {
          ...tweetData,
          replyChain: [],
          hasMoreInChain: false,
        };

        const [lightNoChainResult, darkNoChainResult] = await Promise.all([
          renderTweetImage(tweetDataWithoutChain, "light"),
          renderTweetImage(tweetDataWithoutChain, "dark"),
        ]);

        results.push(
          ...(await Promise.all([
            uploadInlinePhoto(tweetId, "light-no-chain", lightNoChainResult),
            uploadInlinePhoto(tweetId, "dark-no-chain", darkNoChainResult),
          ])),
        );

        generatedImages.push(
          {
            height: lightNoChainResult.height,
            sizeBytes: lightNoChainResult.buffer.length,
            theme: "light-no-chain",
            width: lightNoChainResult.width,
          },
          {
            height: darkNoChainResult.height,
            sizeBytes: darkNoChainResult.buffer.length,
            theme: "dark-no-chain",
            width: darkNoChainResult.width,
          },
        );
      }

      ctx.logger.info(
        {
          generatedImages,
          tweetId,
          videoResultType: videoResult?.type,
          videoSkipped: video !== undefined && videoResult === null,
        },
        "Generated tweet inline results",
      );

      await ctx.answerInlineQuery(results);

      ctx.logger.info({ tweetId }, "Inline query answered successfully");
    } catch (error) {
      ctx.logger.error({ error, tweetId }, "Failed to generate inline tweet images");

      if (error instanceof Error && error.message === TWEET_NOT_FOUND_MESSAGE) {
        await ctx.answerInlineQuery([
          InlineQueryResultBuilder.article(`tweet-not-found:${tweetId}`, TWEET_NOT_FOUND_MESSAGE).text(
            "Could not fetch this tweet. It may be private or deleted.",
          ),
        ]);

        return;
      }

      await ctx.answerInlineQuery([]);
    }
  });

// A video already sent by the bot has a file_id, which rich messages require; otherwise
// Telegram fetches the X video URL itself, and the post text goes into the caption.
// GIFs over the mpeg4_gif limit go out as regular videos; anything over Telegram's URL limit,
// or of unknown size, gets no video result, leaving the rendered cards.
async function buildInlineVideoResult(tweet: FxEmbedTweet, video: FxEmbedVideo, replyChain: TweetData[]) {
  const id = `tweet:${tweet.id}:video`;
  const title = `${tweet.author.name} (@${tweet.author.screen_name})`;

  const cachedVideo = await prisma.video.findFirst({
    where: { tweetId: tweet.id },
    orderBy: { createdAt: "desc" },
  });

  if (cachedVideo) {
    return InlineQueryResultBuilder.article(id, title, {
      description: tweet.getDisplayText(),
      thumbnail_url: video.thumbnail_url,
    }).rich(
      TweetRichMessage.build({
        tweet,
        replyChain,
        video: cachedVideo.telegramFileId,
        width: cachedVideo.width ?? undefined,
        height: cachedVideo.height ?? undefined,
      }),
    );
  }

  const sizeBytes = await runtime.runPromise(
    HttpClient.head(video.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaNoBody(ContentLengthResponse)),
      Effect.map((response) => response.headers["content-length"]),
      Effect.timeout(Duration.millis(VIDEO_HEAD_TIMEOUT_MS)),
      Effect.option,
    ),
  );

  if (!Option.exists(sizeBytes, (size) => size <= VIDEO_URL_LIMIT_BYTES)) {
    return null;
  }

  const caption = TweetRichMessage.caption({ tweet, replyChain });

  const captionOptions = {
    caption: caption.caption,
    caption_entities: caption.caption_entities,
    show_caption_above_media: true,
  };

  return video.type === "gif" && Option.exists(sizeBytes, (size) => size <= MPEG4_GIF_URL_LIMIT_BYTES)
    ? InlineQueryResultBuilder.mpeg4gif(id, video.url, video.thumbnail_url, {
        ...captionOptions,
        mpeg4_width: video.width,
        mpeg4_height: video.height,
      })
    : InlineQueryResultBuilder.videoMp4(id, title, video.url, video.thumbnail_url, {
        ...captionOptions,
        description: tweet.getDisplayText(),
        video_width: video.width,
        video_height: video.height,
      });
}

// Telegram Desktop caches inline images by URL; a thumbnail sharing the photo URL let a
// partially downloaded preview show up as the sent photo (gray lower half).
async function uploadInlinePhoto(tweetId: string, variant: string, result: RenderResult) {
  const s3Path = `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${variant}.jpg`;
  const thumbnailS3Path = `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${variant}-thumb.jpg`;

  await Promise.all([
    s3.write(s3Path, result.buffer, { type: IMAGE_JPEG_TYPE }),
    s3.write(
      thumbnailS3Path,
      await sharp(result.buffer).resize({ width: THUMBNAIL_WIDTH }).jpeg({ quality: 80 }).toBuffer(),
      { type: IMAGE_JPEG_TYPE },
    ),
  ]);

  return InlineQueryResultBuilder.photo(`tweet:${tweetId}:${variant}`, `${env.BASE_CDN_URL}/${s3Path}`, {
    thumbnail_url: `${env.BASE_CDN_URL}/${thumbnailS3Path}`,
    caption: `https://x.com/i/status/${tweetId}`,
    photo_width: result.width,
    photo_height: result.height,
  });
}

chats.callbackQuery(/^tweet_img:toggle:(?<tweetId>\d+):(?<theme>light|dark):(?<userId>\d+)$/u, async (ctx) => {
  // The regex callback query route guarantees all named match groups are present
  const { theme, tweetId, userId } = Schema.decodeUnknownSync(
    Schema.Struct({
      theme: Schema.Literals(["light", "dark"]),
      tweetId: Schema.String,
      userId: Schema.String,
    }),
  )(typeof ctx.match === "string" ? undefined : ctx.match.groups);

  const newTheme = theme;
  const ownerId = userId;

  if (ctx.from.id !== Number(ownerId)) {
    await ctx.answerCallbackQuery({
      text: "Only the person who requested this image can change the theme",
      show_alert: true,
    });

    return;
  }

  ctx.logger.info({ userId: ctx.from.id, tweetId, newTheme }, "Processing theme toggle callback");

  await ctx.answerCallbackQuery({
    text: `Generating ${newTheme} theme...`,
  });

  try {
    const result = await runtime.runPromise(generateTweetImage(tweetId, newTheme));

    ctx.logger.debug({ tweetId, newTheme }, "Theme toggle image generated");

    await ctx.editMessageMedia(
      {
        type: "photo",
        media: new InputFile(result.buffer, `tweet-${tweetId}.jpg`),
        caption: ctx.msg?.caption,
      },
      {
        reply_markup: createThemeKeyboard(tweetId, newTheme, ctx.from.id),
      },
    );
  } catch (error) {
    if (error instanceof GrammyError) {
      ctx.logger.warn({ error, tweetId }, "Failed to edit message for theme toggle");
    } else {
      throw error;
    }
  }
});

export default composer;

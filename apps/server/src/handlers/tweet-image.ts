import { extractTweetId, isTwitterUrl } from "@starlight/utils";
import { Schema } from "effect";
import { Composer, GrammyError, InlineKeyboard, InlineQueryResultBuilder, InputFile } from "grammy";
import sharp from "sharp";
import env from "@/env";
import { findEmbeddableVideo, renderTweetImage } from "@/services/render";
import type { RenderResult } from "@/services/render";
import { runtime } from "@/services/runtime";
import {
  generateTweetImage,
  generateTweetVideo,
  prepareTweetData,
  readCachedTweetVideoMeta,
  TWEET_IMAGE_CACHE_PREFIX,
} from "@/services/tweet/tweet-image.service";
import type { CachedTweetVideoMeta, Theme } from "@/services/tweet/tweet-image.service";
import { TwitterApi } from "@/services/twitter-api";
import { s3 } from "@/storage";
import type { Context } from "@/types";

const composer = new Composer<Context>();
const chats = composer.chatType(["private", "group", "supergroup"]);

const TWEET_NOT_FOUND_MESSAGE = "Tweet not found";
const IMAGE_JPEG_TYPE = "image/jpeg";
const THUMBNAIL_WIDTH = 320;
const TWEET_TRANSLATION_LANGUAGE = "en";
const VIDEO_URL_LIMIT_BYTES = 20 * 1024 * 1024;
const RENDERING_CALLBACK_DATA = "tweet_vid:rendering";
const CHOSEN_INLINE_VIDEO_RE = /^tweet_vid:(?<tweetId>\d+):(?<theme>light|dark)$/u;

function createThemeKeyboard(tweetId: string, currentTheme: Theme, userId: number): InlineKeyboard {
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  const buttonText = currentTheme === "dark" ? "☀️ Change theme" : "🌙 Change theme";

  return new InlineKeyboard().text(buttonText, `tweet_img:toggle:${tweetId}:${nextTheme}:${userId}`);
}

function buildCachedInlineVideoCard(
  tweetId: string,
  theme: Theme,
  title: string,
  meta: CachedTweetVideoMeta,
  description: string,
) {
  return InlineQueryResultBuilder.videoMp4(
    `tweet_vid:${tweetId}:${theme}:cached`,
    title,
    `${env.BASE_CDN_URL}/${meta.mp4Path}`,
    `${env.BASE_CDN_URL}/${meta.thumbnailPath}`,
    {
      caption: `https://x.com/i/status/${tweetId}`,
      description,
      video_duration: meta.duration,
      video_height: meta.height,
      video_width: meta.width,
    },
  );
}

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
      const hasVideo = findEmbeddableVideo(tweetData) !== null;

      if (hasVideo) {
        const [cachedLight, cachedDark] = await Promise.all([
          runtime.runPromise(readCachedTweetVideoMeta(tweetId, "light")),
          runtime.runPromise(readCachedTweetVideoMeta(tweetId, "dark")),
        ]);

        const lightCachedOk = cachedLight !== null && cachedLight.sizeBytes <= VIDEO_URL_LIMIT_BYTES;
        const darkCachedOk = cachedDark !== null && cachedDark.sizeBytes <= VIDEO_URL_LIMIT_BYTES;

        // Telegram can only swap an inline message into a video when it starts as media with a reply_markup,
        // so uncached video tweets send the static card photo with an "In progress..." state and edit in-place on selection.
        const [lightPlaceholder, darkPlaceholder] = await Promise.all([
          lightCachedOk ? null : renderTweetImage(tweetData, "light"),
          darkCachedOk ? null : renderTweetImage(tweetData, "dark"),
        ]);

        const results = await Promise.all([
          lightCachedOk
            ? buildCachedInlineVideoCard(tweetId, "light", "Light theme (video)", cachedLight, tweetData.text)
            : uploadPendingInlineVideoPhoto(tweetId, "light", "Light theme (video)", lightPlaceholder!),
          darkCachedOk
            ? buildCachedInlineVideoCard(tweetId, "dark", "Dark theme (video)", cachedDark, tweetData.text)
            : uploadPendingInlineVideoPhoto(tweetId, "dark", "Dark theme (video)", darkPlaceholder!),
        ]);

        ctx.logger.info(
          { darkCached: darkCachedOk, lightCached: lightCachedOk, tweetId },
          "Generated inline tweet video results",
        );

        await ctx.answerInlineQuery(results);

        return;
      }

      const [lightResult, darkResult] = await Promise.all([
        renderTweetImage(tweetData, "light"),
        renderTweetImage(tweetData, "dark"),
      ]);

      const results = await Promise.all([
        uploadInlinePhoto(tweetId, "light", "Light theme", lightResult),
        uploadInlinePhoto(tweetId, "dark", "Dark theme", darkResult),
      ]);

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
            uploadInlinePhoto(tweetId, "light-no-chain", "Light theme, without replies", lightNoChainResult),
            uploadInlinePhoto(tweetId, "dark-no-chain", "Dark theme, without replies", darkNoChainResult),
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

      ctx.logger.info({ generatedImages, tweetId }, "Generated tweet inline results");

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

composer.on("chosen_inline_result", async (ctx) => {
  const match = CHOSEN_INLINE_VIDEO_RE.exec(ctx.chosenInlineResult.result_id);

  if (!match?.groups) {
    return;
  }

  const { theme, tweetId } = Schema.decodeUnknownSync(
    Schema.Struct({
      theme: Schema.Literals(["light", "dark"]),
      tweetId: Schema.String,
    }),
  )(match.groups);

  const inlineMessageId = ctx.chosenInlineResult.inline_message_id;

  if (inlineMessageId === undefined || inlineMessageId === "") {
    ctx.logger.warn({ theme, tweetId }, "Missing inline_message_id for chosen inline video result");

    return;
  }

  const caption = `https://x.com/i/status/${tweetId}`;

  try {
    await runtime.runPromise(generateTweetVideo(tweetId, theme));
    const meta = await runtime.runPromise(readCachedTweetVideoMeta(tweetId, theme));

    if (!meta || meta.sizeBytes > VIDEO_URL_LIMIT_BYTES) {
      ctx.logger.warn(
        { sizeBytes: meta?.sizeBytes, theme, tweetId },
        "Rendered inline tweet video unavailable on CDN or over Telegram URL limit",
      );
      await ctx.api.editMessageCaptionInline(inlineMessageId, {
        caption,
        reply_markup: { inline_keyboard: [] },
      });

      return;
    }

    await ctx.api.editMessageMediaInline(inlineMessageId, {
      caption,
      cover: `${env.BASE_CDN_URL}/${meta.thumbnailPath}`,
      duration: meta.duration,
      height: meta.height,
      media: `${env.BASE_CDN_URL}/${meta.mp4Path}`,
      supports_streaming: true,
      type: "video",
      width: meta.width,
    });

    ctx.logger.info({ sizeBytes: meta.sizeBytes, theme, tweetId }, "Updated inline message with rendered tweet video");
  } catch (error) {
    ctx.logger.warn({ error, theme, tweetId }, "Failed to update inline message with rendered tweet video");

    try {
      await ctx.api.editMessageCaptionInline(inlineMessageId, {
        caption,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (cleanupError) {
      ctx.logger.debug({ error: cleanupError, tweetId }, "Failed to clear rendering state on inline message");
    }
  }
});

composer.callbackQuery(RENDERING_CALLBACK_DATA, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Rendering video, please wait..." });
});

async function uploadPendingInlineVideoPhoto(tweetId: string, theme: Theme, title: string, result: RenderResult) {
  const s3Path = `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${theme}.jpg`;
  const thumbnailS3Path = `${TWEET_IMAGE_CACHE_PREFIX}/${tweetId}/${theme}-thumb.jpg`;

  await Promise.all([
    s3.write(s3Path, result.buffer, { type: IMAGE_JPEG_TYPE }),
    s3.write(
      thumbnailS3Path,
      await sharp(result.buffer).resize({ width: THUMBNAIL_WIDTH }).jpeg({ quality: 80 }).toBuffer(),
      { type: IMAGE_JPEG_TYPE },
    ),
  ]);

  return InlineQueryResultBuilder.photo(`tweet_vid:${tweetId}:${theme}`, `${env.BASE_CDN_URL}/${s3Path}`, {
    caption: `⏳ Rendering video...\n\nhttps://x.com/i/status/${tweetId}`,
    photo_height: result.height,
    photo_width: result.width,
    reply_markup: new InlineKeyboard().text("⏳ Rendering video...", RENDERING_CALLBACK_DATA),
    thumbnail_url: `${env.BASE_CDN_URL}/${thumbnailS3Path}`,
    title,
  });
}

// Telegram Desktop caches inline images by URL; a thumbnail sharing the photo URL let a
// partially downloaded preview show up as the sent photo (gray lower half).
async function uploadInlinePhoto(tweetId: string, variant: string, title: string, result: RenderResult) {
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
    caption: `https://x.com/i/status/${tweetId}`,
    photo_height: result.height,
    photo_width: result.width,
    thumbnail_url: `${env.BASE_CDN_URL}/${thumbnailS3Path}`,
    title,
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

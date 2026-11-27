import { cleanupTweetText, extractTweetId, prisma } from "@starlight/utils";
import { Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Composer, GrammyError, InlineKeyboard, InputFile } from "grammy";
import tmp from "tmp";
import env from "@/env";
import { bot } from "@/bot";
import type { FxEmbedTweet, FxEmbedVideo } from "@/services/fxembed/types";
import { runtime } from "@/services/runtime";
import { generateTweetImage, generateTweetVideo } from "@/services/tweet/tweet-image.service";
import type { Theme } from "@/services/tweet/tweet-image.service";
import { TwitterApi } from "@/services/twitter-api";
import { downloadVideo, downloadVideoFromUrl } from "@/services/video";
import type { VideoInformation } from "@/services/video";
import type { Context } from "@/types";

const composer = new Composer<Context>();
const TWEET_TRANSLATION_LANGUAGE = "en";

const CANT_DOWNLOAD_MESSAGE = "Can't download video, sorry.";
const VIDEO_TOO_LARGE_MESSAGE = "Video is too large, can't be sent.";
const TELEGRAM_VIDEO_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const VIDEO_HEAD_TIMEOUT_MS = 3000;
const VIDEO_DIMENSIONS_RE = /\/(?<width>\d+)x(?<height>\d+)\//u;

const ContentLengthResponse = Schema.Struct({
  headers: Schema.Struct({ "content-length": Schema.FiniteFromString }),
});

const WHITELISTED_CHAT_IDS = new Set(env.WHITELIST_CHAT_IDS);

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);
const chats = composer.chatType(["private", "group", "supergroup"]);
const whitelistedGroupChat = groupChat.filter((ctx) => WHITELISTED_CHAT_IDS.has(ctx.chat.id));
const whitelistedChats = chats.filter((ctx) => ctx.chat?.type === "private" || WHITELISTED_CHAT_IDS.has(ctx.chat.id));

type SendMessageOptions = Parameters<Context["api"]["sendMessage"]>[2];

type SendVideoOptions = Parameters<Context["api"]["sendVideo"]>[2];

async function sendTextMessage(ctx: Context, text: string, options?: SendMessageOptions) {
  if (ctx.chat?.type === "private") {
    return await ctx.reply(text, options);
  }

  return await bot.api.sendMessage(ctx.chatId!, text, options);
}

async function sendVideoMessage(ctx: Context, video: string | InputFile, options?: SendVideoOptions) {
  if (ctx.chat?.type === "private") {
    return await ctx.replyWithVideo(video, options);
  }

  return await bot.api.sendVideo(ctx.chatId!, video, options);
}

const VIDEO_RENDERING_CALLBACK_DATA = "video:rendering";

function createRenderingKeyboard(sourceUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("Rendering...⏳", VIDEO_RENDERING_CALLBACK_DATA);

  if (sourceUrl !== undefined && sourceUrl !== "") {
    keyboard.row().url("Source", sourceUrl);
  }

  return keyboard;
}

function createVideoKeyboard(
  videoId: string,
  descriptionAction: "add" | "remove" | null,
  ownerId: number,
  sourceUrl?: string,
  theme?: Theme,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const hasDescriptionAction = descriptionAction !== null;

  if (descriptionAction === "add") {
    keyboard.text("Add description", `video:add_desc:${videoId}:${ownerId}`);
  } else if (descriptionAction === "remove") {
    const currentTheme = theme ?? "light";
    const nextTheme: Theme = currentTheme === "dark" ? "light" : "dark";
    const themeLabel = currentTheme === "dark" ? "☀️ Change theme" : "🌙 Change theme";
    // Keep buttons on separate rows so narrow tall video cards never truncate their labels.
    keyboard.text(themeLabel, `video:theme:${videoId}:${nextTheme}:${ownerId}`).row();
    keyboard.text("Remove description", `video:remove_desc:${videoId}:${ownerId}`);
  }

  if (sourceUrl !== undefined && sourceUrl !== "") {
    if (hasDescriptionAction) {
      keyboard.row();
    }

    keyboard.url("Source", sourceUrl);
  }

  return keyboard;
}

function getTweetUrl(tweetId: string): string {
  return `https://x.com/i/status/${tweetId}`;
}

async function tryDeleteMessage(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch (error) {
    if (error instanceof GrammyError) {
      ctx.logger.debug({ error: error.message }, "Could not delete command message (missing permissions)");
    } else {
      throw error;
    }
  }
}

async function sendExistingVideoIfExists(
  ctx: Context,
  tweetId: string,
  ownerId: number,
  sourceUrl: string | undefined,
  messageThreadId?: number,
): Promise<boolean> {
  const existingVideo = await prisma.video.findFirst({
    where: { tweetId },
    orderBy: { createdAt: "desc" },
  });

  if (!existingVideo) {
    return false;
  }

  ctx.logger.info({ tweetId, videoId: existingVideo.id }, "Found existing video; sending via Telegram file ID");

  const descriptionAction = existingVideo.tweetText !== null && existingVideo.tweetText !== "" ? "add" : null;

  try {
    await sendVideoMessage(ctx, existingVideo.telegramFileId, {
      width: existingVideo.width ?? undefined,
      height: existingVideo.height ?? undefined,
      supports_streaming: true,
      reply_markup:
        descriptionAction !== null || (sourceUrl !== undefined && sourceUrl !== "")
          ? createVideoKeyboard(existingVideo.id, descriptionAction, ownerId, sourceUrl)
          : undefined,
      message_thread_id: messageThreadId,
    });

    ctx.logger.info({ chatId: ctx.chatId, tweetId, videoId: existingVideo.id }, "Sent existing video");

    return true;
  } catch (error) {
    ctx.logger.error({ error, videoId: existingVideo.id }, "Error sending existing video, will download fresh copy");

    return false;
  }
}

interface FreshDownloadParams {
  apiVideos: readonly FxEmbedVideo[];
  ctx: Context;
  link: string;
  messageThreadId?: number;
  tempDirName: string;
}

type FreshDownloadOutcome =
  | { status: "complete"; videos: VideoInformation[] }
  | { status: "partial"; videos: VideoInformation[] }
  | { status: "empty" }
  | { status: "failed_notified" };

async function fetchContentLength(url: string): Promise<number | null> {
  const size = await runtime.runPromise(
    HttpClient.head(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaNoBody(ContentLengthResponse)),
      Effect.map((response) => response.headers["content-length"]),
      Effect.timeout(Duration.millis(VIDEO_HEAD_TIMEOUT_MS)),
      Effect.option,
    ),
  );

  return Option.getOrNull(size);
}

async function selectUploadableApiVideo(
  apiVideo: FxEmbedVideo,
): Promise<{ height: number; url: string; width: number }> {
  const mp4Formats = (apiVideo.formats ?? [])
    .filter((format) => format.container === "mp4" || /\.mp4(?:\?|$)/iu.test(format.url))
    .toSorted((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0));

  if (mp4Formats.length === 0) {
    return { height: apiVideo.height, url: apiVideo.url, width: apiVideo.width };
  }

  for (const format of mp4Formats) {
    // Sequential HEAD from highest bitrate down stops at the first variant that fits Telegram's 50 MB upload cap.
    // oxlint-disable-next-line react-doctor/async-await-in-loop
    const sizeBytes = await fetchContentLength(format.url);

    if (sizeBytes !== null && sizeBytes <= TELEGRAM_VIDEO_UPLOAD_LIMIT_BYTES) {
      const dims = VIDEO_DIMENSIONS_RE.exec(format.url)?.groups;
      const width = Number(dims?.width);
      const height = Number(dims?.height);

      return {
        height: Number.isFinite(height) && height > 0 ? height : apiVideo.height,
        url: format.url,
        width: Number.isFinite(width) && width > 0 ? width : apiVideo.width,
      };
    }
  }

  const smallest = mp4Formats.at(-1)!;

  return { height: apiVideo.height, url: smallest.url, width: apiVideo.width };
}

async function downloadFreshVideos(params: FreshDownloadParams): Promise<FreshDownloadOutcome> {
  const { apiVideos, ctx, link, messageThreadId, tempDirName } = params;

  try {
    try {
      const videos = await downloadVideo(link, tempDirName);
      const hasOversized = videos.some((video) => Bun.file(video.filePath).size > TELEGRAM_VIDEO_UPLOAD_LIMIT_BYTES);

      if (!hasOversized || apiVideos.length === 0) {
        return videos.length === 0 ? { status: "empty" } : { status: "complete", videos };
      }

      ctx.logger.warn({ link }, "yt-dlp video exceeds Telegram 50 MB limit, trying smaller FxTwitter variant");
    } catch (error) {
      ctx.logger.warn({ error }, "yt-dlp download failed, trying fxtwitter API fallback");
    }

    if (apiVideos.length === 0) {
      return { status: "empty" };
    }

    const videos: VideoInformation[] = [];

    try {
      for (const apiVideo of apiVideos) {
        // Sequential by design: upstream rate limits (yt-dlp / media CDN)
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const selected = await selectUploadableApiVideo(apiVideo);

        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const info = await downloadVideoFromUrl(selected.url, tempDirName, {
          height: selected.height,
          width: selected.width,
        });

        videos.push(info);
      }
    } catch (fallbackError) {
      ctx.logger.error({ error: fallbackError }, "Fallback video download also failed");

      return videos.length === 0 ? { status: "empty" } : { status: "partial", videos };
    }

    return { status: "complete", videos };
  } catch (error) {
    ctx.logger.error({ error, link }, "Failed to download video");

    await sendTextMessage(ctx, CANT_DOWNLOAD_MESSAGE, {
      message_thread_id: messageThreadId,
    });

    return { status: "failed_notified" };
  }
}

async function sendTweetImageFallback(ctx: Context, tweet: FxEmbedTweet, messageThreadId?: number): Promise<void> {
  const tweetId = tweet.id;
  ctx.logger.info({ tweetId }, "No video in tweet, generating image instead");

  try {
    const result = await runtime.runPromise(generateTweetImage(tweetId, "light", tweet));
    const photo = new InputFile(result.buffer, `tweet-${tweetId}.jpg`);

    const options = {
      caption: getTweetUrl(tweetId),
      message_thread_id: messageThreadId,
      reply_markup:
        ctx.chat?.type === "private"
          ? new InlineKeyboard().text("🌙 Change theme", `tweet_img:toggle:${tweetId}:dark:${ctx.from!.id}`)
          : undefined,
    };

    await (ctx.chat?.type === "private"
      ? ctx.replyWithPhoto(photo, options)
      : bot.api.sendPhoto(ctx.chatId!, photo, options));
  } catch (imgError) {
    ctx.logger.error({ error: imgError, tweetId }, "Failed to generate tweet image");
    await sendTextMessage(ctx, "Can't process this tweet, sorry.", {
      message_thread_id: messageThreadId,
    });
  }
}

async function sendDownloadedVideos(params: {
  ctx: Context;
  messageThreadId?: number;
  ownerId: number;
  sourceUrl: string | undefined;
  tweetText: string | undefined;
  tweetId: string | null;
  videos: VideoInformation[];
}): Promise<void> {
  const { ctx, messageThreadId, ownerId, sourceUrl, tweetId, tweetText, videos } = params;

  for (const video of videos) {
    const fileSize = Bun.file(video.filePath).size;

    if (fileSize > TELEGRAM_VIDEO_UPLOAD_LIMIT_BYTES) {
      ctx.logger.warn({ filePath: video.filePath, fileSize }, "Video exceeds Telegram 50 MB upload limit");
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await sendTextMessage(ctx, VIDEO_TOO_LARGE_MESSAGE, {
        message_thread_id: messageThreadId,
      });
      continue;
    }

    try {
      ctx.logger.debug({ chatId: ctx.chatId, filePath: video.filePath }, "Sending video");

      const videoId = Bun.randomUUIDv7();

      // Sequential by design: upstream rate limits (Telegram Bot API flood control)
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await sendDownloadedVideo({
        ctx,
        messageThreadId,
        ownerId,
        sourceUrl,
        tweetId,
        tweetText,
        video,
        videoId,
      });

      ctx.logger.info({ chatId: ctx.chatId, filePath: video.filePath, videoId }, "Sent video");
    } catch (error) {
      ctx.logger.error({ error, filePath: video.filePath }, "Failed to send video");

      const message =
        error instanceof GrammyError && error.error_code === 413 ? VIDEO_TOO_LARGE_MESSAGE : CANT_DOWNLOAD_MESSAGE;

      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await sendTextMessage(ctx, message, {
        message_thread_id: messageThreadId,
      });

      if (error instanceof GrammyError && error.error_code !== 413) {
        throw error;
      }
    }
  }
}

async function sendDownloadedVideo(params: {
  ctx: Context;
  messageThreadId?: number;
  ownerId: number;
  sourceUrl: string | undefined;
  tweetId: string | null;
  tweetText: string | undefined;
  video: VideoInformation;
  videoId: string;
}): Promise<void> {
  if (params.tweetId === null) {
    await sendVideoMessage(params.ctx, new InputFile(params.video.filePath), {
      width: params.video.metadata?.width,
      height: params.video.metadata?.height,
      supports_streaming: true,
      message_thread_id: params.messageThreadId,
    });

    return;
  }

  const descriptionAction = params.tweetText !== undefined && params.tweetText !== "" ? "add" : null;

  const sentMessage = await sendVideoMessage(params.ctx, new InputFile(params.video.filePath), {
    width: params.video.metadata?.width,
    height: params.video.metadata?.height,
    supports_streaming: true,
    reply_markup:
      descriptionAction !== null || (params.sourceUrl !== undefined && params.sourceUrl !== "")
        ? createVideoKeyboard(params.videoId, descriptionAction, params.ownerId, params.sourceUrl)
        : undefined,
    message_thread_id: params.messageThreadId,
  });

  await prisma.video.create({
    data: {
      id: params.videoId,
      userId: params.ctx.user!.id,
      tweetId: params.tweetId,
      tweetText: params.tweetText,
      telegramFileId: sentMessage.video.file_id,
      telegramFileUniqueId: sentMessage.video.file_unique_id,
      width: sentMessage.video.width,
      height: sentMessage.video.height,
    },
  });
}

async function handleVideoRequest(
  ctx: Context,
  link: string,
  ownerId: number,
  messageThreadId?: number,
): Promise<void> {
  const tweetId = extractTweetId(link);
  const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const sourceUrl = isGroupChat && tweetId !== null ? getTweetUrl(tweetId) : undefined;

  const tweet =
    tweetId === null
      ? null
      : await runtime.runPromise(TwitterApi.getFxTweet(tweetId, TWEET_TRANSLATION_LANGUAGE)).catch((cause: unknown) => {
          ctx.logger.warn({ error: cause, tweetId }, "Could not fetch FxTwitter metadata, falling back to yt-dlp");

          return null;
        });

  const apiVideos = [tweet, tweet?.quote].flatMap((item) => item?.media?.videos ?? []);

  if (tweet && apiVideos.length === 0) {
    await ctx.replyWithChatAction("upload_photo", { message_thread_id: messageThreadId });
    await sendTweetImageFallback(ctx, tweet, messageThreadId);

    return;
  }

  await ctx.replyWithChatAction("upload_video", { message_thread_id: messageThreadId });

  if (tweetId !== null && (await sendExistingVideoIfExists(ctx, tweetId, ownerId, sourceUrl, messageThreadId))) {
    return;
  }

  const tempDir = tmp.dirSync({ unsafeCleanup: true });

  try {
    const outcome = await downloadFreshVideos({
      apiVideos,
      ctx,
      link,
      messageThreadId,
      tempDirName: tempDir.name,
    });

    switch (outcome.status) {
      case "failed_notified": {
        return;
      }

      case "empty": {
        await sendTextMessage(ctx, CANT_DOWNLOAD_MESSAGE, { message_thread_id: messageThreadId });

        return;
      }

      case "partial": {
        await sendTextMessage(ctx, "Some videos couldn't be downloaded. Sending the available ones.", {
          message_thread_id: messageThreadId,
        });
        break;
      }

      case "complete": {
        break;
      }
      // no default
    }

    const tweetText = tweet
      ? [cleanupTweetText(tweet.getDisplayText()), cleanupTweetText(tweet.quote?.getDisplayText())]
          .filter((text): text is string => Boolean(text))
          .join("\n\n") || undefined
      : undefined;

    await sendDownloadedVideos({
      ctx,
      messageThreadId,
      ownerId,
      sourceUrl,
      tweetText,
      tweetId,
      videos: outcome.videos,
    });
  } finally {
    tempDir.removeCallback();
  }
}

privateChat
  .on(":text")
  .filter((ctx) => ctx.msg.text.startsWith("https://"))
  .use(async (ctx) => {
    await handleVideoRequest(ctx, ctx.msg.text, ctx.from.id);
  });

whitelistedGroupChat
  .command(["v", "video"])
  .filter((ctx) => !ctx.match.trim().startsWith("https://"))
  .use(async (ctx) => {
    await tryDeleteMessage(ctx);
    await bot.api.sendMessage(ctx.chatId, "Не позорься и скинь нормальную ссылку", {
      message_thread_id: ctx.msg.message_thread_id,
    });
  });

whitelistedGroupChat
  .command(["v", "video"])
  .filter((ctx) => ctx.match.trim().startsWith("https://"))
  .use(async (ctx) => {
    await tryDeleteMessage(ctx);
    await handleVideoRequest(ctx, ctx.match.trim(), ctx.from.id, ctx.msg.message_thread_id);
  });

async function editToRenderedTweetCard(params: {
  ctx: Context;
  keyboard: InlineKeyboard;
  theme: Theme;
  tweet?: FxEmbedTweet;
  tweetId: string;
  videoId: string;
}): Promise<boolean> {
  try {
    const rendered = await runtime.runPromise(generateTweetVideo(params.tweetId, params.theme, params.tweet));

    await params.ctx.editMessageMedia(
      {
        duration: rendered.duration,
        height: rendered.height,
        media: new InputFile(rendered.buffer, `tweet-${params.tweetId}.mp4`),
        supports_streaming: true,
        thumbnail: new InputFile(rendered.thumbnail, `tweet-${params.tweetId}-thumb.jpg`),
        type: "video",
        width: rendered.width,
      },
      { reply_markup: params.keyboard },
    );

    return true;
  } catch (videoError) {
    params.ctx.logger.warn(
      { error: videoError, theme: params.theme, tweetId: params.tweetId, videoId: params.videoId },
      "Could not render tweet video card, falling back to image",
    );
  }

  try {
    const image = await runtime.runPromise(generateTweetImage(params.tweetId, params.theme, params.tweet));

    await params.ctx.editMessageMedia(
      {
        media: new InputFile(image.buffer, `tweet-${params.tweetId}.jpg`),
        type: "photo",
      },
      { reply_markup: params.keyboard },
    );

    return true;
  } catch (imageError) {
    params.ctx.logger.warn(
      { error: imageError, theme: params.theme, tweetId: params.tweetId, videoId: params.videoId },
      "Could not render fallback tweet image",
    );

    return false;
  }
}

async function tryEditReplyMarkup(ctx: Context, replyMarkup: InlineKeyboard, videoId: string): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: replyMarkup });
  } catch (error) {
    ctx.logger.debug({ error, videoId }, "Could not update video reply markup");
  }
}

whitelistedChats.callbackQuery(
  /^video:(?<action>add_desc|remove_desc):(?<videoId>[^:]+):(?<ownerId>\d+)$/u,
  async (ctx) => {
    // The regex callback query route guarantees all named match groups are present
    const {
      action,
      ownerId: ownerIdRaw,
      videoId,
    } = Schema.decodeUnknownSync(
      Schema.Struct({
        action: Schema.Literals(["add_desc", "remove_desc"]),
        ownerId: Schema.String,
        videoId: Schema.String,
      }),
    )(typeof ctx.match === "string" ? undefined : ctx.match.groups);

    const ownerId = Number(ownerIdRaw);

    if (ctx.from.id !== ownerId) {
      await ctx.answerCallbackQuery({
        text: "Может по голове себе постучишь?",
        show_alert: true,
      });

      return;
    }

    await ctx.answerCallbackQuery();

    const video = await prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      return;
    }

    const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    const sourceUrl = isGroupChat ? getTweetUrl(video.tweetId) : undefined;

    if (action === "remove_desc") {
      await ctx.editMessageMedia(
        {
          height: video.height ?? undefined,
          media: video.telegramFileId,
          supports_streaming: true,
          type: "video",
          width: video.width ?? undefined,
        },
        { reply_markup: createVideoKeyboard(videoId, "add", ownerId, sourceUrl) },
      );

      return;
    }

    await tryEditReplyMarkup(ctx, createRenderingKeyboard(sourceUrl), videoId);

    const tweet = await runtime
      .runPromise(TwitterApi.getFxTweet(video.tweetId, TWEET_TRANSLATION_LANGUAGE))
      .catch((cause: unknown) => {
        ctx.logger.warn({ error: cause, tweetId: video.tweetId, videoId }, "Could not fetch video description");

        return null;
      });

    if (tweet) {
      const tweetText = [cleanupTweetText(tweet.getDisplayText()), cleanupTweetText(tweet.quote?.getDisplayText())]
        .filter((text): text is string => Boolean(text))
        .join("\n\n");

      if (tweetText && tweetText !== video.tweetText) {
        await prisma.video.update({
          where: { id: video.id },
          data: { tweetText },
        });
      }

      const updated = await editToRenderedTweetCard({
        ctx,
        keyboard: createVideoKeyboard(videoId, "remove", ownerId, sourceUrl, "light"),
        theme: "light",
        tweet,
        tweetId: video.tweetId,
        videoId,
      });

      if (updated) {
        return;
      }
    }

    await tryEditReplyMarkup(ctx, createVideoKeyboard(videoId, "add", ownerId, sourceUrl), videoId);
    await sendTextMessage(ctx, "Can't load the description right now. Please try again.", {
      message_thread_id: ctx.msg!.message_thread_id,
    });
  },
);

whitelistedChats.callbackQuery(VIDEO_RENDERING_CALLBACK_DATA, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Rendering...⏳" });
});

whitelistedChats.callbackQuery(/^video:theme:(?<videoId>[^:]+):(?<theme>light|dark):(?<ownerId>\d+)$/u, async (ctx) => {
  // The regex callback query route guarantees all named match groups are present
  const {
    ownerId: ownerIdRaw,
    theme,
    videoId,
  } = Schema.decodeUnknownSync(
    Schema.Struct({
      ownerId: Schema.String,
      theme: Schema.Literals(["light", "dark"]),
      videoId: Schema.String,
    }),
  )(typeof ctx.match === "string" ? undefined : ctx.match.groups);

  const ownerId = Number(ownerIdRaw);

  if (ctx.from.id !== ownerId) {
    await ctx.answerCallbackQuery({
      text: "Может по голове себе постучишь?",
      show_alert: true,
    });

    return;
  }

  await ctx.answerCallbackQuery({ text: `Switching to ${theme} theme...` });

  const video = await prisma.video.findUnique({
    where: { id: videoId },
  });

  if (!video) {
    return;
  }

  const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const sourceUrl = isGroupChat ? getTweetUrl(video.tweetId) : undefined;
  const keyboard = createVideoKeyboard(videoId, "remove", ownerId, sourceUrl, theme);

  const updated = await editToRenderedTweetCard({
    ctx,
    keyboard,
    theme,
    tweetId: video.tweetId,
    videoId,
  });

  if (!updated) {
    await sendTextMessage(ctx, "Can't switch theme right now. Please try again.", {
      message_thread_id: ctx.msg!.message_thread_id,
    });
  }
});

privateChat.on(":video", async (ctx) => {
  const fileUniqueId = ctx.msg.video.file_unique_id;

  const video = await prisma.video.findFirst({
    where: { telegramFileUniqueId: fileUniqueId },
    orderBy: { createdAt: "desc" },
  });

  if (!video) {
    await ctx.reply("Can't find a source, sorry.");

    return;
  }

  await ctx.reply(getTweetUrl(video.tweetId));
});

whitelistedChats
  .command("source")
  .filter(
    (ctx) =>
      ctx.msg.reply_to_message === undefined ||
      (ctx.msg.reply_to_message.video === undefined &&
        ctx.msg.reply_to_message.rich_message?.blocks.some((block) => block.type === "video") !== true),
  )
  .use(async (ctx) => {
    await ctx.reply("Please, reply to a message with a video.");
  });

whitelistedChats
  .command("source")
  .filter(
    (ctx) =>
      ctx.msg.reply_to_message?.video !== undefined ||
      ctx.msg.reply_to_message?.rich_message?.blocks.some((block) => block.type === "video") === true,
  )
  .use(async (ctx) => {
    const repliedVideo =
      ctx.msg.reply_to_message!.video ??
      ctx.msg.reply_to_message!.rich_message?.blocks.find((block) => block.type === "video")?.video;

    const video = await prisma.video.findFirst({
      where: {
        telegramFileUniqueId: repliedVideo!.file_unique_id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!video) {
      await ctx.reply("No source found, sorry.");

      return;
    }

    await ctx.reply(getTweetUrl(video.tweetId));
  });

export default composer;

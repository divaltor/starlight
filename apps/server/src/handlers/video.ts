import { cleanupTweetText, extractTweetId, prisma } from "@starlight/utils";
import { Composer, GrammyError, InlineKeyboard, InputFile } from "grammy";
import tmp from "tmp";
import env from "@/env";
import { bot } from "@/bot";
import type { FxEmbedTweet } from "@/services/fxembed/types";
import { runtime } from "@/services/runtime";
import { generateTweetImage } from "@/services/tweet/tweet-image.service";
import { TweetRichMessage } from "@/services/tweet/tweet-rich-message";
import { TwitterApi } from "@/services/twitter-api";
import { downloadVideo, downloadVideoFromUrl } from "@/services/video";
import type { VideoInformation } from "@/services/video";
import type { Context } from "@/types";

const composer = new Composer<Context>();
const TWEET_TRANSLATION_LANGUAGE = "en";

const CANT_DOWNLOAD_MESSAGE = "Can't download video, sorry.";

const WHITELISTED_CHAT_IDS = new Set(env.WHITELIST_CHAT_IDS);

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);
const chats = composer.chatType(["private", "group", "supergroup"]);
const whitelistedGroupChat = groupChat.filter((ctx) => WHITELISTED_CHAT_IDS.has(ctx.chat.id));
const whitelistedChats = chats.filter((ctx) => ctx.chat?.type === "private" || WHITELISTED_CHAT_IDS.has(ctx.chat.id));

type SendMessageOptions = Parameters<Context["api"]["sendMessage"]>[2];
type SendVideoOptions = Parameters<Context["api"]["sendVideo"]>[2];

function sendTextMessage(ctx: Context, text: string, options?: SendMessageOptions) {
  if (ctx.chat?.type === "private") {
    return ctx.reply(text, options);
  }

  return bot.api.sendMessage(ctx.chatId!, text, options);
}

function sendVideoMessage(ctx: Context, video: string | InputFile, options?: SendVideoOptions) {
  if (ctx.chat?.type === "private") {
    return ctx.replyWithVideo(video, options);
  }

  return bot.api.sendVideo(ctx.chatId!, video, options);
}

function createVideoKeyboard(
  videoId: string,
  descriptionAction: "add" | "remove" | null,
  ownerId: number,
  sourceUrl?: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const hasDescriptionAction = descriptionAction !== null;

  if (descriptionAction === "add") {
    keyboard.text("Add description", `video:add_desc:${videoId}:${ownerId}`);
  } else if (descriptionAction === "remove") {
    keyboard.text("Remove description", `video:remove_desc:${videoId}:${ownerId}`);
  }

  if (sourceUrl) {
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

function getDescriptionAction(tweetText: string | null, showDescription: boolean): "add" | "remove" | null {
  if (!tweetText) {
    return null;
  }

  return showDescription ? "remove" : "add";
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

  const descriptionAction = existingVideo.tweetText ? "add" : null;

  try {
    await sendVideoMessage(ctx, existingVideo.telegramFileId, {
      width: existingVideo.width ?? undefined,
      height: existingVideo.height ?? undefined,
      supports_streaming: true,
      reply_markup:
        existingVideo.tweetText || sourceUrl
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
  ctx: Context;
  isTwitterLink: boolean;
  link: string;
  messageThreadId?: number;
  tempDirName: string;
  tweetId: string | null;
}

interface FreshDownloadSuccess {
  status: "ok";
  tweet: FxEmbedTweet | null;
  videoDownloadFailed: boolean;
  videos: VideoInformation[];
}

async function downloadFreshVideos(params: FreshDownloadParams): Promise<FreshDownloadSuccess | { status: "failed" }> {
  const { ctx, isTwitterLink, link, messageThreadId, tempDirName, tweetId } = params;

  try {
    if (!isTwitterLink || tweetId === null) {
      const videos = await downloadVideo(link, tempDirName);
      return { status: "ok", videos, tweet: null, videoDownloadFailed: false };
    }

    const [downloadResult, tweetResult] = await Promise.allSettled([
      downloadVideo(link, tempDirName),
      runtime.runPromise(TwitterApi.getFxTweet(tweetId, TWEET_TRANSLATION_LANGUAGE)),
    ]);

    const tweet = tweetResult.status === "fulfilled" ? tweetResult.value : null;

    if (downloadResult.status === "fulfilled") {
      return { status: "ok", videos: downloadResult.value, tweet, videoDownloadFailed: false };
    }

    ctx.logger.warn({ error: downloadResult.reason }, "yt-dlp download failed, trying fxtwitter API fallback");

    const apiVideos = tweet?.media?.videos;

    if (!(apiVideos && apiVideos.length > 0)) {
      return { status: "ok", videos: [], tweet, videoDownloadFailed: true };
    }

    const videos: VideoInformation[] = [];

    try {
      for (const apiVideo of apiVideos) {
        // Sequential by design: upstream rate limits (yt-dlp / media CDN)
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const info = await downloadVideoFromUrl(apiVideo.url, tempDirName, {
          width: apiVideo.width,
          height: apiVideo.height,
        });
        videos.push(info);
      }
    } catch (fallbackError) {
      ctx.logger.error({ error: fallbackError }, "Fallback video download also failed");
      return { status: "ok", videos, tweet, videoDownloadFailed: true };
    }

    return { status: "ok", videos, tweet, videoDownloadFailed: false };
  } catch (error) {
    ctx.logger.error({ error, link }, "Failed to download video");

    await sendTextMessage(ctx, CANT_DOWNLOAD_MESSAGE, {
      message_thread_id: messageThreadId,
    });
    return { status: "failed" };
  }
}

async function sendTweetImageFallback(ctx: Context, tweetId: string, messageThreadId?: number): Promise<void> {
  ctx.logger.info({ tweetId }, "No video in tweet, generating image instead");

  try {
    const result = await runtime.runPromise(generateTweetImage(tweetId, "light"));
    const photo = new InputFile(result.buffer, `tweet-${tweetId}.jpg`);
    const options = { caption: getTweetUrl(tweetId), message_thread_id: messageThreadId };
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
      if (error instanceof GrammyError) {
        ctx.logger.error({ error, filePath: video.filePath }, "Failed to send video");
        if (error.error_code === 413) {
          await sendTextMessage(ctx, "Video is too large, can't be sent.", {
            message_thread_id: messageThreadId,
          });
        } else {
          await sendTextMessage(ctx, CANT_DOWNLOAD_MESSAGE, {
            message_thread_id: messageThreadId,
          });
          throw error;
        }
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

  const descriptionAction = params.tweetText ? "add" : null;
  const sentMessage = await sendVideoMessage(params.ctx, new InputFile(params.video.filePath), {
    width: params.video.metadata?.width,
    height: params.video.metadata?.height,
    supports_streaming: true,
    reply_markup:
      params.tweetText || params.sourceUrl
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

async function shouldStopAfterDownloadFailure(params: {
  ctx: Context;
  isTwitterLink: boolean;
  messageThreadId?: number;
  outcome: FreshDownloadSuccess;
  tweetId: string | null;
}): Promise<boolean> {
  const { ctx, isTwitterLink, messageThreadId, outcome, tweetId } = params;

  if (!(isTwitterLink && outcome.videoDownloadFailed && outcome.videos.length === 0)) {
    return false;
  }

  const hasVideo = Boolean(outcome.tweet?.media?.videos && outcome.tweet.media.videos.length > 0);

  if (!hasVideo && outcome.tweet && tweetId !== null) {
    await sendTweetImageFallback(ctx, tweetId, messageThreadId);
    return true;
  }

  await sendTextMessage(ctx, CANT_DOWNLOAD_MESSAGE, {
    message_thread_id: messageThreadId,
  });
  return true;
}

async function handleVideoRequest(
  ctx: Context,
  link: string,
  ownerId: number,
  messageThreadId?: number,
): Promise<void> {
  await ctx.replyWithChatAction("upload_video");

  const tweetId = extractTweetId(link);
  const isTwitterLink = tweetId !== null;
  const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const sourceUrl = isGroupChat && tweetId ? getTweetUrl(tweetId) : undefined;

  if (
    isTwitterLink &&
    tweetId !== null &&
    (await sendExistingVideoIfExists(ctx, tweetId, ownerId, sourceUrl, messageThreadId))
  ) {
    return;
  }

  const tempDir = tmp.dirSync({ unsafeCleanup: true });

  try {
    const outcome = await downloadFreshVideos({
      ctx,
      isTwitterLink,
      link,
      messageThreadId,
      tempDirName: tempDir.name,
      tweetId,
    });

    if (outcome.status === "failed") {
      return;
    }

    const handledByFallback = await shouldStopAfterDownloadFailure({
      ctx,
      isTwitterLink,
      messageThreadId,
      outcome,
      tweetId,
    });

    if (handledByFallback) {
      return;
    }

    const tweetText = outcome.tweet
      ? [cleanupTweetText(outcome.tweet.getDisplayText()), cleanupTweetText(outcome.tweet.quote?.getDisplayText())]
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
    await bot.api.sendMessage(ctx.chatId!, "Не позорься и скинь нормальную ссылку", {
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

whitelistedChats.callbackQuery(
  /^video:(?<action>add_desc|remove_desc):(?<videoId>[^:]+):(?<ownerId>\d+)$/u,
  async (ctx) => {
    // The regex callback query route guarantees all named match groups are present
    const {
      action,
      ownerId: ownerIdRaw,
      videoId,
    } = (ctx.match as RegExpMatchArray).groups as Record<"action" | "ownerId" | "videoId", string>;
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

    const showDescription = action === "add_desc";
    const tweet = showDescription
      ? await runtime.runPromise(TwitterApi.getFxTweet(video.tweetId, TWEET_TRANSLATION_LANGUAGE))
      : undefined;

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
    }

    const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    const sourceUrl = isGroupChat ? getTweetUrl(video.tweetId) : undefined;
    const keyboard = createVideoKeyboard(
      videoId,
      getDescriptionAction(video.tweetText, showDescription),
      ownerId,
      sourceUrl,
    );
    await (showDescription
      ? bot.api.sendRichMessage(
          ctx.chatId!,
          TweetRichMessage.build({
            tweet: tweet!,
            video: video.telegramFileId,
            width: video.width ?? undefined,
            height: video.height ?? undefined,
          }),
          {
            reply_markup: keyboard,
            message_thread_id: ctx.msg!.message_thread_id,
          },
        )
      : ctx.editMessageMedia(
          {
            type: "video",
            media: video.telegramFileId,
            width: video.width ?? undefined,
            height: video.height ?? undefined,
            supports_streaming: true,
          },
          { reply_markup: keyboard },
        ));

    if (showDescription) {
      await ctx.deleteMessage();
    }
  },
);

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
        !ctx.msg.reply_to_message.rich_message?.blocks.some((block) => block.type === "video")),
  )
  .use((ctx) => {
    ctx.reply("Please, reply to a message with a video.");
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

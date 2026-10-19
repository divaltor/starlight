import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { prisma } from "@starlight/utils";
import { Effect } from "effect";
import { Bot } from "grammy";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { FxEmbedTweet } from "@/services/fxembed/types";
import { TwitterApi } from "@/services/twitter-api";
import type { Context } from "@/types";

const downloads = await import("@/services/video");
const tweetImages = await import("@/services/tweet/tweet-image.service");
const findVideo = prisma.video.findFirst;
const createVideo = prisma.video.create;

afterEach(() => {
  mock.restore();
  Reflect.set(prisma.video, "findFirst", findVideo);
  Reflect.set(prisma.video, "create", createVideo);
});

test.each([
  { emptyMainVideos: false, downloadFails: false },
  { emptyMainVideos: true, downloadFails: false },
  { emptyMainVideos: true, downloadFails: true },
])("test_sends_quoted_video_when_%j", async (params) => {
  const tweetData = {
    author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
    created_at: "2026-10-18",
    created_timestamp: 1_792_310_400,
    id: "2111829705599172805",
    likes: 0,
    replies: 0,
    retweets: 0,
    text: "Some people are really out there living life man",
    url: "https://x.com/CoastalFuturist/status/2111829705599172805",
  };

  const quote = new FxEmbedTweet({
    ...tweetData,
    id: "2111468041951383899",
    text: "Found a dude on Instagram recording his adventures smuggling diesel off east Africa",
    media: {
      videos: [{ type: "video", url: "https://video.example/quoted.mp4", thumbnail_url: "", width: 576, height: 1024 }],
    },
  });

  spyOn(TwitterApi, "getFxTweet").mockReturnValue(
    Effect.succeed(
      new FxEmbedTweet({ ...tweetData, quote, media: params.emptyMainVideos ? { videos: [] } : undefined }),
    ),
  );
  spyOn(tweetImages, "generateTweetImage").mockReturnValue(Effect.fail(new Error("Video must not become an image")));
  Reflect.set(
    prisma.video,
    "findFirst",
    mock(async () => await Promise.resolve(null)),
  );
  Reflect.set(
    prisma.video,
    "create",
    mock(async () => {
      await Promise.resolve();
    }),
  );
  const download = spyOn(downloads, "downloadVideo");

  if (params.downloadFails) {
    download.mockRejectedValue(new Error("yt-dlp unavailable"));
  } else {
    download.mockResolvedValue([{ filePath: "downloaded.mp4", metadata: { width: 576, height: 1024 } }]);
  }

  spyOn(downloads, "downloadVideoFromUrl").mockImplementation(
    async (url, _folder, metadata) =>
      await Promise.resolve({
        filePath: url,
        metadata: metadata ?? {},
      }),
  );

  const sent: { method: string; payload: unknown }[] = [];

  const testBot = new Bot<Context>("123:test", {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "Bot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
    client: {
      fetch: async () =>
        await Promise.resolve(
          Response.json({
            ok: true,
            result: {
              message_id: 2,
              date: 0,
              chat: { id: 1, type: "private" },
              video: { file_id: "video", file_unique_id: "unique", width: 576, height: 1024, duration: 33 },
            },
          }),
        ),
    },
  });

  testBot.api.config.use(async (previous, method, payload, signal) => {
    sent.push({ method, payload });

    return await previous(method, payload, signal);
  });
  testBot.use(async (ctx, next) => {
    ctx.logger = logger;
    ctx.user = {
      id: "user",
      telegramId: 1n,
      firstName: "User",
      lastName: null,
      username: null,
      isBot: false,
      isPublic: false,
      cookies: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    await next();
  });
  testBot.use(videoHandler);

  await testBot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private", first_name: "User" },
      from: { id: 1, is_bot: false, first_name: "User" },
      text: tweetData.url,
    },
  });

  expect(sent.map((message) => message.method)).toEqual(["sendChatAction", "sendVideo"]);
  expect(sent[0]?.payload).toMatchObject({ action: "upload_video" });
  expect(sent[1]?.payload).toMatchObject({
    width: 576,
    height: 1024,
    supports_streaming: true,
  });
  expect(sent[1]?.payload).toHaveProperty(
    "video.fileData",
    params.downloadFails ? "https://video.example/quoted.mp4" : "downloaded.mp4",
  );
});

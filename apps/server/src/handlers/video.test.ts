import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { prisma } from "@starlight/utils";
import { Effect } from "effect";
import { Bot } from "grammy";
import { bot } from "@/bot";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { FxEmbedTweet } from "@/services/fxembed/types";
import { TwitterApi } from "@/services/twitter-api";
import type { Context } from "@/types";

const downloads = await import("@/services/video");
const tweetImages = await import("@/services/tweet/tweet-image.service");
const findVideo = prisma.video.findFirst;
const createVideo = prisma.video.create;
const findUniqueVideo = prisma.video.findUnique;
const updateVideo = prisma.video.update;

afterEach(() => {
  mock.restore();
  Reflect.set(prisma.video, "findFirst", findVideo);
  Reflect.set(prisma.video, "create", createVideo);
  Reflect.set(prisma.video, "findUnique", findUniqueVideo);
  Reflect.set(prisma.video, "update", updateVideo);
});

test.each<{
  emptyMainVideos: boolean;
  downloadFails: boolean;
  emptyDownload?: boolean;
  metadataUnavailable?: boolean;
  fallbackFailureAt?: number;
  videoCount?: number;
  expectedFiles: string[];
  expectedNotice?: string;
}>([
  { emptyMainVideos: false, downloadFails: false, expectedFiles: ["downloaded.mp4"] },
  { emptyMainVideos: true, downloadFails: false, expectedFiles: ["downloaded.mp4"] },
  { emptyMainVideos: true, downloadFails: true, expectedFiles: ["https://video.example/quoted.mp4"] },
  {
    emptyMainVideos: true,
    downloadFails: true,
    fallbackFailureAt: 2,
    videoCount: 3,
    expectedFiles: ["https://video.example/quoted.mp4"],
    expectedNotice: "Some videos couldn't be downloaded. Sending the available ones.",
  },
  {
    emptyMainVideos: true,
    downloadFails: true,
    fallbackFailureAt: 1,
    expectedFiles: [],
    expectedNotice: "Can't download video, sorry.",
  },
  {
    emptyMainVideos: true,
    downloadFails: false,
    emptyDownload: true,
    expectedFiles: [],
    expectedNotice: "Can't download video, sorry.",
  },
  {
    emptyMainVideos: true,
    downloadFails: true,
    metadataUnavailable: true,
    expectedFiles: [],
    expectedNotice: "Can't download video, sorry.",
  },
])("test_delivers_available_videos_and_reports_missing_downloads_when_%j", async (params) => {
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
      videos: Array.from({ length: params.videoCount ?? 1 }, (_, index) => ({
        type: "video",
        url: index === 0 ? "https://video.example/quoted.mp4" : `https://video.example/quoted-${index}.mp4`,
        thumbnail_url: "",
        width: 576,
        height: 1024,
      })),
    },
  });

  spyOn(TwitterApi, "getFxTweet").mockReturnValue(
    params.metadataUnavailable === true
      ? Effect.fail(new TwitterApi.TwitterApiError({ message: "FxTwitter unavailable" }))
      : Effect.succeed(
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
    download.mockResolvedValue(
      params.emptyDownload === true ? [] : [{ filePath: "downloaded.mp4", metadata: { width: 576, height: 1024 } }],
    );
  }

  const fallback = spyOn(downloads, "downloadVideoFromUrl").mockImplementation(async (url, _folder, metadata) => {
    if (fallback.mock.calls.length === params.fallbackFailureAt) {
      throw new Error("Media CDN unavailable");
    }

    return await Promise.resolve({ filePath: url, metadata: metadata ?? {} });
  });

  const sent: { method: string; payload: unknown }[] = [];
  const testBot = createTestBot(sent);

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

  expect(sent[0]?.payload).toMatchObject({ action: "upload_video" });
  expect(sent.flatMap((message) => (message.method === "sendVideo" ? [message.payload] : []))).toMatchObject(
    params.expectedFiles.map((filePath) => ({
      width: 576,
      height: 1024,
      supports_streaming: true,
      video: { fileData: filePath },
    })),
  );
  expect(sent.flatMap((message) => (message.method === "sendMessage" ? [message.payload] : []))).toEqual(
    params.expectedNotice === undefined ? [] : [expect.objectContaining({ text: params.expectedNotice })],
  );
  expect(sent.some((message) => message.method === "sendPhoto")).toBe(false);
});

test.each([
  { failure: "missing tweet", result: Effect.succeed(null) },
  {
    failure: "fetch error",
    result: Effect.fail(new TwitterApi.TwitterApiError({ message: "FxTwitter unavailable" })),
  },
])("test_preserves_video_and_offers_retry_when_%j", async (params) => {
  spyOn(TwitterApi, "getFxTweet").mockReturnValue(params.result);
  Reflect.set(
    prisma.video,
    "findUnique",
    mock(
      async () =>
        await Promise.resolve({
          id: "stored-video",
          tweetId: "42",
          tweetText: "Cached description",
          telegramFileId: "video",
        }),
    ),
  );
  const sent: { method: string; payload: unknown }[] = [];
  const testBot = createTestBot(sent);
  spyOn(bot.api, "sendRichMessage").mockImplementation(testBot.api.sendRichMessage.bind(testBot.api));

  await testBot.handleUpdate({
    update_id: 1,
    callback_query: {
      id: "callback",
      chat_instance: "chat",
      from: { id: 1, is_bot: false, first_name: "User" },
      data: "video:add_desc:stored-video:1",
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 1, type: "private", first_name: "User" },
        message_thread_id: 7,
        video: { file_id: "video", file_unique_id: "unique", width: 576, height: 1024, duration: 33 },
        reply_markup: {
          inline_keyboard: [[{ text: "Add description", callback_data: "video:add_desc:stored-video:1" }]],
        },
      },
    },
  });

  expect(sent.map((message) => message.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
  expect(sent[1]?.payload).toMatchObject({
    chat_id: 1,
    message_thread_id: 7,
    text: "Can't load the description right now. Please try again.",
  });
});

test.each([
  { storedText: null, fetchedText: "Fresh description" },
  { storedText: "", fetchedText: "Fresh description" },
  { storedText: "Cached description", fetchedText: "Fresh description" },
  { storedText: null, fetchedText: "" },
  { storedText: "", fetchedText: "" },
  { storedText: "Cached description", fetchedText: "" },
])("test_keeps_description_toggle_reversible_when_%j", async (params) => {
  spyOn(TwitterApi, "getFxTweet").mockReturnValue(
    Effect.succeed(
      new FxEmbedTweet({
        author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
        created_at: "2026-10-18",
        created_timestamp: 1_792_310_400,
        id: "42",
        likes: 0,
        replies: 0,
        retweets: 0,
        text: params.fetchedText,
        url: "https://x.com/i/status/42",
      }),
    ),
  );

  const video = {
    id: "stored-video",
    tweetId: "42",
    tweetText: params.storedText,
    telegramFileId: "video",
    width: 576,
    height: 1024,
  };

  Reflect.set(
    prisma.video,
    "findUnique",
    mock(async () => await Promise.resolve({ ...video })),
  );
  Reflect.set(
    prisma.video,
    "update",
    mock(async (args: { data: { tweetText: string } }) => await Promise.resolve(Object.assign(video, args.data))),
  );
  const sent: { method: string; payload: unknown }[] = [];
  const testBot = createTestBot(sent);
  spyOn(bot.api, "sendRichMessage").mockImplementation(testBot.api.sendRichMessage.bind(testBot.api));

  const callback = {
    id: "callback",
    chat_instance: "chat",
    from: { id: 1, is_bot: false, first_name: "User" },
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 1, type: "private", first_name: "User" },
      message_thread_id: 7,
    },
  } as const;

  await testBot.handleUpdate({ update_id: 1, callback_query: { ...callback, data: "video:add_desc:stored-video:1" } });

  expect(sent.map((message) => message.method)).toEqual(["answerCallbackQuery", "sendRichMessage", "deleteMessage"]);
  expect(sent[1]?.payload).toMatchObject({
    chat_id: 1,
    message_thread_id: 7,
    reply_markup: {
      inline_keyboard: [[{ text: "Remove description", callback_data: "video:remove_desc:stored-video:1" }]],
    },
  });
  expect(sent[1]?.payload).toHaveProperty(
    "rich_message.blocks",
    expect.arrayContaining([
      {
        type: "paragraph",
        text: [{ type: "bold", text: "Author" }, " ", { type: "url", text: "@author", url: "https://x.com/author" }],
      },
      { type: "video", video: { type: "video", media: "video", width: 576, height: 1024, supports_streaming: true } },
    ]),
  );

  sent.length = 0;
  await testBot.handleUpdate({
    update_id: 2,
    callback_query: { ...callback, data: "video:remove_desc:stored-video:1" },
  });

  expect(sent.map((message) => message.method)).toEqual(["answerCallbackQuery", "editMessageMedia"]);
  expect(sent[1]?.payload).toMatchObject({
    media: { type: "video", media: "video", width: 576, height: 1024, supports_streaming: true },
    reply_markup: { inline_keyboard: [[{ text: "Add description", callback_data: "video:add_desc:stored-video:1" }]] },
  });

  sent.length = 0;
  await testBot.handleUpdate({ update_id: 3, callback_query: { ...callback, data: "video:add_desc:stored-video:1" } });

  expect(sent.map((message) => message.method)).toEqual(["answerCallbackQuery", "sendRichMessage", "deleteMessage"]);
  expect(sent[1]?.payload).toHaveProperty("reply_markup.inline_keyboard", [
    [{ text: "Remove description", callback_data: "video:remove_desc:stored-video:1" }],
  ]);
});

function createTestBot(sent: { method: string; payload: unknown }[]) {
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

  return testBot;
}

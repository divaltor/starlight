import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { Bot } from "grammy";
import sharp from "sharp";
import tweetImageHandler from "@/handlers/tweet-image";
import { logger } from "@/logger";
import { FxEmbedTweet } from "@/services/fxembed/types";
import { TwitterApi } from "@/services/twitter-api";
import { s3 } from "@/storage";
import type { Context } from "@/types";

const renderModule = await import("@/services/render");
const tweetImageService = await import("@/services/tweet/tweet-image.service");

afterEach(() => {
  mock.restore();
});

// Product rule: /quote command is removed and must not trigger any response.
test("test_ignores_removed_quote_command", async () => {
  const sent: { method: string; payload: unknown }[] = [];
  const testBot = createTestBot(sent);

  await testBot.handleUpdate({
    update_id: 1,
    message: {
      chat: { first_name: "User", id: 1, type: "private" },
      date: 0,
      entities: [{ length: 6, offset: 0, type: "bot_command" }],
      from: { first_name: "User", id: 1, is_bot: false },
      message_id: 1,
      text: "/quote https://x.com/mitchellh/status/2125713695233970521",
    },
  });

  expect(sent).toEqual([]);
});

// Product rule: uncached inline video queries return an "In progress..." photo placeholder with markup
// and edit the inline message in-place into the rendered CDN video when selected (or clear the placeholder on failure).
test.each([{ outcome: "success" as const }, { outcome: "failure" as const }])(
  "test_handles_inline_video_placeholder_and_in_place_edit_on_$outcome",
  async (params) => {
    const tweet = new FxEmbedTweet({
      author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
      created_at: "2026-11-26",
      created_timestamp: 1_795_651_800,
      id: "2125713695233970521",
      likes: 10,
      media: {
        videos: [
          {
            height: 720,
            thumbnail_url: "https://pbs.twimg.com/thumb.jpg",
            type: "video",
            url: "https://video.twimg.com/video.mp4",
            width: 1052,
          },
        ],
      },
      replies: 1,
      retweets: 2,
      text: "Video tweet",
      url: "https://x.com/author/status/2125713695233970521",
    });

    const placeholderJpg = await sharp({ create: { background: "#ffffff", channels: 3, height: 16, width: 16 } })
      .jpeg()
      .toBuffer();

    spyOn(TwitterApi, "getFxTweet").mockReturnValue(Effect.succeed(tweet));
    spyOn(renderModule, "renderTweetImage").mockResolvedValue({
      buffer: placeholderJpg,
      failedUrls: [],
      height: 1914,
      width: 1100,
    });
    spyOn(s3, "write").mockResolvedValue(0);

    let rendered = false;

    spyOn(tweetImageService, "readCachedTweetVideoMeta").mockImplementation((_tweetId, theme) =>
      Effect.succeed(
        rendered
          ? {
              duration: 141,
              height: 1914,
              mp4Path: `tweets/v4/2125713695233970521/${theme}.mp4`,
              sizeBytes: 8_700_000,
              thumbnailPath: `tweets/v4/2125713695233970521/${theme}-video-thumb.jpg`,
              width: 1100,
            }
          : null,
      ),
    );

    spyOn(tweetImageService, "generateTweetVideo").mockImplementation(() => {
      if (params.outcome === "failure") {
        return Effect.fail(new Error("ffmpeg failed"));
      }

      rendered = true;

      return Effect.succeed({
        buffer: Buffer.from("mp4"),
        duration: 141,
        failedUrls: [],
        height: 1914,
        thumbnail: placeholderJpg,
        width: 1100,
      });
    });

    const sent: { method: string; payload: unknown }[] = [];
    const testBot = createTestBot(sent);

    await testBot.handleUpdate({
      inline_query: {
        from: { first_name: "User", id: 1, is_bot: false },
        id: "iq-1",
        offset: "",
        query: "https://x.com/author/status/2125713695233970521",
      },
      update_id: 1,
    });

    expect(sent.map((entry) => entry.method)).toEqual(["answerInlineQuery"]);
    expect(sent[0]?.payload).toMatchObject({
      inline_query_id: "iq-1",
      results: [
        {
          caption: "⏳ Rendering video...\n\nhttps://x.com/i/status/2125713695233970521",
          id: "tweet_vid:2125713695233970521:light",
          reply_markup: {
            inline_keyboard: [[{ callback_data: "tweet_vid:rendering", text: "⏳ Rendering video..." }]],
          },
          type: "photo",
        },
        {
          caption: "⏳ Rendering video...\n\nhttps://x.com/i/status/2125713695233970521",
          id: "tweet_vid:2125713695233970521:dark",
          reply_markup: {
            inline_keyboard: [[{ callback_data: "tweet_vid:rendering", text: "⏳ Rendering video..." }]],
          },
          type: "photo",
        },
      ],
    });

    sent.length = 0;

    await testBot.handleUpdate({
      chosen_inline_result: {
        from: { first_name: "User", id: 1, is_bot: false },
        inline_message_id: "inline-msg-1",
        query: "https://x.com/author/status/2125713695233970521",
        result_id: "tweet_vid:2125713695233970521:light",
      },
      update_id: 2,
    });

    if (params.outcome === "success") {
      expect(sent.map((entry) => entry.method)).toEqual(["editMessageMedia"]);
      expect(sent[0]?.payload).toMatchObject({
        inline_message_id: "inline-msg-1",
        media: {
          caption: "https://x.com/i/status/2125713695233970521",
          duration: 141,
          height: 1914,
          supports_streaming: true,
          type: "video",
          width: 1100,
        },
      });
    } else {
      expect(sent.map((entry) => entry.method)).toEqual(["editMessageCaption"]);
      expect(sent[0]?.payload).toMatchObject({
        caption: "https://x.com/i/status/2125713695233970521",
        inline_message_id: "inline-msg-1",
        reply_markup: { inline_keyboard: [] },
      });
    }
  },
);

// Product rule: already-cached video cards skip the placeholder and return direct inline video results.
test("test_returns_cached_inline_video_cards_directly", async () => {
  const tweet = new FxEmbedTweet({
    author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
    created_at: "2026-11-26",
    created_timestamp: 1_795_651_800,
    id: "99",
    likes: 0,
    media: {
      videos: [
        {
          height: 720,
          thumbnail_url: "https://pbs.twimg.com/thumb.jpg",
          type: "video",
          url: "https://video.twimg.com/video.mp4",
          width: 1052,
        },
      ],
    },
    replies: 0,
    retweets: 0,
    text: "Cached video tweet",
    url: "https://x.com/author/status/99",
  });

  spyOn(TwitterApi, "getFxTweet").mockReturnValue(Effect.succeed(tweet));
  spyOn(tweetImageService, "readCachedTweetVideoMeta").mockImplementation((_tweetId, theme) =>
    Effect.succeed({
      duration: 20,
      height: 1200,
      mp4Path: `tweets/v4/99/${theme}.mp4`,
      sizeBytes: 3_000_000,
      thumbnailPath: `tweets/v4/99/${theme}-video-thumb.jpg`,
      width: 1100,
    }),
  );

  const sent: { method: string; payload: unknown }[] = [];
  const testBot = createTestBot(sent);

  await testBot.handleUpdate({
    inline_query: {
      from: { first_name: "User", id: 1, is_bot: false },
      id: "iq-cached",
      offset: "",
      query: "https://x.com/author/status/99",
    },
    update_id: 1,
  });

  expect(sent.map((entry) => entry.method)).toEqual(["answerInlineQuery"]);
  expect(sent[0]?.payload).toMatchObject({
    results: [
      { id: "tweet_vid:99:light:cached", type: "video", video_duration: 20, video_height: 1200, video_width: 1100 },
      { id: "tweet_vid:99:dark:cached", type: "video", video_duration: 20, video_height: 1200, video_width: 1100 },
    ],
  });
});

function createTestBot(sent: { method: string; payload: unknown }[]) {
  const testBot = new Bot<Context>("123:test", {
    botInfo: {
      allows_users_to_create_topics: false,
      can_connect_to_business: false,
      can_join_groups: true,
      can_manage_bots: false,
      can_read_all_group_messages: false,
      first_name: "Bot",
      has_main_web_app: false,
      has_topics_enabled: false,
      id: 123,
      is_bot: true,
      supports_inline_queries: true,
      supports_join_request_queries: false,
      username: "test_bot",
    },
    client: {
      fetch: async () => await Promise.resolve(Response.json({ ok: true, result: true })),
    },
  });

  testBot.api.config.use(async (previous, method, payload, signal) => {
    sent.push({ method, payload });

    return await previous(method, payload, signal);
  });
  testBot.use(async (ctx, next) => {
    ctx.logger = logger;
    await next();
  });
  testBot.use(tweetImageHandler);

  return testBot;
}

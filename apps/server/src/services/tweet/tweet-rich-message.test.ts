import { expect, test } from "bun:test";
import { FxEmbedTweet } from "@/services/fxembed/types";
import { TweetRichMessage } from "@/services/tweet/tweet-rich-message";

test("test_preserves_x_reading_order_for_quoted_video_posts", () => {
  const quote = new FxEmbedTweet({
    author: {
      avatar_url: "https://example.com/quoted.jpg",
      id: "quoted-author",
      name: "Quoted Author",
      screen_name: "quoted",
    },
    created_at: "2026-09-17T09:00:00Z",
    created_timestamp: 1_789_632_000,
    id: "quoted-tweet",
    likes: 0,
    replies: 0,
    retweets: 0,
    text: "Quoted text",
    url: "https://x.com/quoted/status/quoted-tweet",
  });
  const tweet = new FxEmbedTweet({
    author: {
      avatar_url: "https://example.com/author.jpg",
      id: "author",
      name: "Main Author",
      screen_name: "main",
    },
    created_at: "2026-09-17T10:00:00Z",
    created_timestamp: 1_789_635_600,
    id: "main-tweet",
    likes: 0,
    quote,
    replies: 0,
    retweets: 0,
    text: "Main text",
    url: "https://x.com/main/status/main-tweet",
  });

  expect(TweetRichMessage.build({ tweet, video: "telegram-video", width: 1280, height: 720 })).toEqual({
    blocks: [
      {
        type: "paragraph",
        text: [{ type: "bold", text: "Main Author" }, " ", { type: "url", text: "@main", url: "https://x.com/main" }],
      },
      { type: "paragraph", text: "Main text" },
      {
        type: "blockquote",
        blocks: [
          {
            type: "paragraph",
            text: [
              { type: "bold", text: "Quoted Author" },
              " ",
              { type: "url", text: "@quoted", url: "https://x.com/quoted" },
            ],
          },
          { type: "paragraph", text: "Quoted text" },
        ],
      },
      {
        type: "video",
        video: {
          type: "video",
          media: "telegram-video",
          width: 1280,
          height: 720,
          supports_streaming: true,
        },
      },
    ],
  });
});

test("test_keeps_hidden_description_as_editable_rich_video", () => {
  expect(TweetRichMessage.build({ video: "telegram-video" })).toEqual({
    blocks: [
      {
        type: "video",
        video: {
          type: "video",
          media: "telegram-video",
          supports_streaming: true,
        },
      },
    ],
  });
});

import { expect, test } from "bun:test";
import { FxEmbedTranslation, FxEmbedTweet } from "@/services/fxembed/types";
import { TweetRichMessage } from "@/services/tweet/tweet-rich-message";

test.each([
  { mainLanguage: "ru", quoteLanguage: "es", mainText: "Русский текст", quoteText: "Translated quote" },
  { mainLanguage: "es", quoteLanguage: "ru", mainText: "Translated main", quoteText: "Русская цитата" },
])("test_preserves_russian_video_text_when_main_is_$mainLanguage_and_quote_is_$quoteLanguage", (params) => {
  const tweetData = {
    author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
    created_at: "2026-10-07",
    created_timestamp: 1_791_331_200,
    id: "1",
    likes: 0,
    replies: 0,
    retweets: 0,
    text: params.mainLanguage === "ru" ? "Русский текст" : "Texto español",
    translation: new FxEmbedTranslation({
      source_lang: params.mainLanguage,
      target_lang: "en",
      text: "Translated main",
    }),
    url: "https://x.com/author/status/1",
  };

  const tweet = new FxEmbedTweet(tweetData);

  const quote = new FxEmbedTweet({
    author: tweet.author,
    created_at: tweet.created_at,
    created_timestamp: tweet.created_timestamp,
    likes: tweet.likes,
    replies: tweet.replies,
    retweets: tweet.retweets,
    url: tweet.url,
    id: "2",
    text: params.quoteLanguage === "ru" ? "Русская цитата" : "Cita española",
    translation: new FxEmbedTranslation({
      source_lang: params.quoteLanguage,
      target_lang: "en",
      text: "Translated quote",
    }),
  });

  const message = TweetRichMessage.build({ tweet: new FxEmbedTweet({ ...tweetData, quote }), video: "telegram-video" });

  expect(tweet.getDisplayText()).toBe(params.mainText);
  expect(quote.getDisplayText()).toBe(params.quoteText);
  expect(message.blocks?.[1]).toEqual({ type: "paragraph", text: params.mainText });
  expect(message.blocks?.[2]).toMatchObject({
    type: "blockquote",
    blocks: [{ type: "paragraph" }, { type: "paragraph", text: params.quoteText }],
  });
});

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

test.each([
  { name: "replies", replyText: "r".repeat(600), postText: "Post text", start: "Reply 3\n", end: "Post text" },
  { name: "post", replyText: "Reply", postText: "p".repeat(1500), start: "Author @author\n\np", end: "p…" },
])("test_keeps_inline_video_caption_within_telegram_limit_when_overflowing_$name", (params) => {
  const tweet = new FxEmbedTweet({
    author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
    created_at: "2026-10-31",
    created_timestamp: 1_793_440_181,
    id: "42",
    likes: 0,
    replies: 0,
    retweets: 0,
    text: params.postText,
    url: "https://x.com/author/status/42",
  });

  const { caption } = TweetRichMessage.caption({
    tweet,
    replyChain: [1, 2, 3].map((index) => ({
      authorName: `Reply ${index}`,
      authorUsername: `reply${index}`,
      text: params.replyText,
    })),
  });

  expect(caption.length).toBeLessThanOrEqual(1024);
  expect(caption.startsWith(params.start)).toBe(true);
  expect(caption.endsWith(`${params.end}\n\nhttps://x.com/i/status/42`)).toBe(true);
});

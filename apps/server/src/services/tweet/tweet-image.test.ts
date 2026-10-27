import { expect, test } from "bun:test";
import { Effect } from "effect";
import { FxEmbedCard, FxEmbedTranslation, FxEmbedTweet } from "@/services/fxembed/types";
import { prepareTweetData } from "@/services/tweet/tweet-image.service";
import { TwitterApi } from "@/services/twitter-api";

test("test_preserves_russian_text_in_main_quotes_and_replies_while_translating_other_languages", async () => {
  const original = {
    author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
    created_at: "2026-09-30",
    created_timestamp: 1_790_726_400,
    id: "1",
    likes: 0,
    replies: 0,
    retweets: 0,
    text: "@parent Оригинальный текст",
    translation: new FxEmbedTranslation({
      source_lang: "ru",
      target_lang: "en",
      text: "@parent Translated text",
    }),
    url: "https://x.com/author/status/1",
  };

  const parent = new FxEmbedTweet({
    ...original,
    id: "2",
    text: "Русский ответ",
    quote: new FxEmbedTweet({
      ...original,
      text: "Texto español",
      translation: new FxEmbedTranslation({ source_lang: "es", target_lang: "en", text: "Spanish text" }),
    }),
  });

  const tweet = new FxEmbedTweet({
    ...original,
    replying_to: "parent",
    replying_to_status: "2",
    quote: new FxEmbedTweet({ ...original, text: "Русская цитата" }),
  });

  const result = await Effect.runPromise(
    prepareTweetData("1").pipe(
      Effect.provideService(TwitterApi.Service, {
        getTweet: () => Effect.succeed(null),
        getFxTweet: (id) => Effect.succeed(id === "1" ? tweet : parent),
      }),
    ),
  );

  expect(result.text).toBe("Оригинальный текст");
  expect(result.translation).toBeNull();
  expect(result.quote?.text).toBe("Русская цитата");
  expect(result.quote?.translation).toBeNull();
  expect(result.replyChain?.[0]?.text).toBe("Русский ответ");
  expect(result.replyChain?.[0]?.translation).toBeNull();
  expect(result.replyChain?.[0]?.quote?.text).toBe("Spanish text");
  expect(result.replyChain?.[0]?.quote?.translation).toEqual({ sourceLanguage: "es" });
});

test("test_renders_the_classified_tweet_without_refetching_it", async () => {
  const tweetData = {
    author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
    created_at: "2026-09-30",
    created_timestamp: 1_790_726_400,
    id: "1",
    likes: 0,
    replies: 0,
    retweets: 0,
    text: "Already fetched tweet",
    url: "https://x.com/author/status/1",
    replying_to: "parent",
    replying_to_status: "2",
  };

  const tweet = new FxEmbedTweet(tweetData);

  const result = await Effect.runPromise(
    prepareTweetData("1", tweet).pipe(
      Effect.provideService(TwitterApi.Service, {
        getTweet: () => Effect.succeed(null),
        getFxTweet: (id) =>
          id === "2"
            ? Effect.succeed(
                new FxEmbedTweet({ ...tweetData, id: "2", text: "Parent tweet", replying_to_status: null }),
              )
            : Effect.fail(new TwitterApi.TwitterApiError({ message: "Main tweet must not be refetched" })),
      }),
    ),
  );

  expect(result.text).toBe("Already fetched tweet");
  expect(result.replyChain?.map((reply) => reply.text)).toEqual(["Parent tweet"]);
});

// The link preview stands in for the trailing link as on X; when media takes
// the card's place the link must stay in the text, or the image loses it.
test.each([
  ["no_media", undefined, "Read this", "Cognitive Mercantilism"],
  [
    "media",
    { photos: [{ height: 1, type: "photo", url: "https://pbs.twimg.com/p.jpg", width: 1 }] },
    "Read this\n\nhttps://example.com/post",
    undefined,
  ],
] as const)("test_card_replaces_trailing_link_when_%s", async (_, media, expectedText, expectedTitle) => {
  const tweet = new FxEmbedTweet({
    author: { avatar_url: "", id: "1", name: "Author", screen_name: "author" },
    card: new FxEmbedCard({ title: "Cognitive Mercantilism", url: "https://example.com/post" }),
    created_at: "2026-10-26",
    created_timestamp: 1_793_047_419,
    id: "1",
    likes: 0,
    media,
    replies: 0,
    retweets: 0,
    text: "Read this\n\nhttps://example.com/post",
    url: "https://x.com/author/status/1",
  });

  const result = await Effect.runPromise(
    prepareTweetData("1", tweet).pipe(
      Effect.provideService(TwitterApi.Service, {
        getTweet: () => Effect.succeed(null),
        getFxTweet: () => Effect.succeed(null),
      }),
    ),
  );

  expect(result.text).toBe(expectedText);
  expect(result.card?.title).toBe(expectedTitle);
});

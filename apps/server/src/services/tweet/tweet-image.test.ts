import { expect, test } from "bun:test";
import { Effect } from "effect";
import { FxEmbedTranslation, FxEmbedTweet } from "@/services/fxembed/types";
import { prepareTweetData } from "@/services/tweet/tweet-image.service";
import { TwitterApi } from "@/services/twitter-api";

test("test_preserves_russian_text_in_main_quotes_and_replies_while_translating_other_languages", async () => {
  const original = new FxEmbedTweet({
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
  });
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

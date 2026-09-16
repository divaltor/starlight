import { expect, test } from "bun:test";
import { FxEmbedTranslation } from "@/services/fxembed/types";

// Upstream derives source_lang_en from an i18n key and leaks the raw key
// (e.g. "language_zh") when the language has no entry; the stored code must
// stay a code so the card can resolve the display name itself.
test("test_stores_iso_code_when_upstream_english_name_is_missing_key_fallback", () => {
  const translation = new FxEmbedTranslation({
    source_lang: "zh",
    source_lang_en: "language_zh",
    target_lang: "en",
    text: "translated text",
  });

  expect(translation.toTranslationData()).toEqual({ sourceLanguage: "zh" });
});

test("test_stores_iso_code_when_upstream_english_name_is_present", () => {
  const translation = new FxEmbedTranslation({
    source_lang: "es",
    source_lang_en: "Spanish",
    target_lang: "en",
    text: "texto traducido",
  });

  expect(translation.toTranslationData()).toEqual({ sourceLanguage: "es" });
});

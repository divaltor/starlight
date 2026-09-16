import { expect, test } from "bun:test";
import { formatShortDate, formatTweetTimestamp, getTranslationLanguage } from "@/services/render/card";

const language = (sourceLanguage: string) => ({ translation: { sourceLanguage } });

// Every bug fix includes its regression test: the card once rendered
// "Translated from language-ZH" because the upstream i18n fallback key
// leaked through to the label.
test.each([
  ["es", "Spanish"],
  ["zh", "Chinese"],
  ["ZH", "Chinese"],
  ["ja", "Japanese"],
  ["ru", "Russian"],
  ["de", "German"],
  ["uk", "Ukrainian"],
] as [string, string][])("test_shows_full_language_name_when_code_is_%s", (code, expected) => {
  expect(getTranslationLanguage(language(code))).toBe(expected);
});

test.each([
  ["language_zh", "Chinese"],
  ["language-ZH", "Chinese"],
  ["language_zh-CN", "Chinese (China)"],
] as [string, string][])("test_recovers_language_when_upstream_leaks_i18n_key_%s", (leaked, expected) => {
  expect(getTranslationLanguage(language(leaked))).toBe(expected);
});

test.each([["Chinese"], ["chinese"], ["Russian"]] as [string][])(
  "test_keeps_english_name_capitalized_when_source_is_%s",
  (name) => {
    expect(getTranslationLanguage(language(name))).toBe(name.charAt(0).toUpperCase() + name.slice(1));
  },
);

test.each([["auto"], ["und"], [""], ["  "]] as [string][])(
  "test_hides_badge_when_source_language_is_meaningless_%s",
  (code) => {
    expect(getTranslationLanguage(language(code))).toBeNull();
  },
);

test("test_hides_badge_when_translation_is_missing", () => {
  expect(getTranslationLanguage({})).toBeNull();
  expect(getTranslationLanguage({ translation: null })).toBeNull();
});

// Static images leave X, so the footer carries the exact post time and child
// rows a short date; both formats are asserted here to lock the placement:
// local components keep the expectations independent of the machine timezone.
test("test_shows_time_before_date_in_footer_timestamp", () => {
  expect(formatTweetTimestamp(new Date(2026, 8, 15, 21, 5))).toBe("9:05 PM · Sep 15, 2026");
});

test("test_omits_year_in_short_date_when_current_year", () => {
  expect(formatShortDate(new Date(new Date().getFullYear(), 4, 9, 21, 5))).toBe("9:05 PM · May 9");
});

test("test_includes_year_in_short_date_when_other_year", () => {
  expect(formatShortDate(new Date(2020, 0, 2, 8, 30))).toBe("8:30 AM · Jan 2, 2020");
});

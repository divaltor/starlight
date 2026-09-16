import { expect, test } from "bun:test";
import { formatShortDate, formatTweetTimestamp, getTranslationLanguage, splitTextRuns } from "@/services/render/card";

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

// Static cards cannot hover or click, so links, mentions, and hashtags must be
// detectable as runs for emphasis styling.
test("test_splits_links_mentions_and_hashtags_into_typed_runs", () => {
  expect(splitTextRuns("Hey @alice see https://example.com/a and #buildinpublic")).toEqual([
    { kind: "plain", value: "Hey " },
    { kind: "mention", value: "@alice" },
    { kind: "plain", value: " see " },
    { kind: "link", value: "https://example.com/a" },
    { kind: "plain", value: " and " },
    { kind: "hashtag", value: "#buildinpublic" },
  ]);
});

test("test_keeps_sentence_punctuation_outside_link_run", () => {
  expect(splitTextRuns("See (https://example.com/a).")).toEqual([
    { kind: "plain", value: "See (" },
    { kind: "link", value: "https://example.com/a" },
    { kind: "plain", value: ")." },
  ]);
});

test("test_returns_single_plain_run_when_no_tokens", () => {
  expect(splitTextRuns("Just words here")).toEqual([{ kind: "plain", value: "Just words here" }]);
});

test("test_ignores_mention_inside_email_address", () => {
  expect(splitTextRuns("Email alice@example.com please")).toEqual([
    { kind: "plain", value: "Email alice@example.com please" },
  ]);
});

test("test_ignores_hashtag_without_word_boundary", () => {
  expect(splitTextRuns("I love word#topic lots")).toEqual([{ kind: "plain", value: "I love word#topic lots" }]);
});

test("test_matches_tokens_after_opening_punctuation", () => {
  expect(splitTextRuns("See (#tag) and @user, ok")).toEqual([
    { kind: "plain", value: "See (" },
    { kind: "hashtag", value: "#tag" },
    { kind: "plain", value: ") and " },
    { kind: "mention", value: "@user" },
    { kind: "plain", value: ", ok" },
  ]);
});

test("test_keeps_balanced_parens_inside_link_run", () => {
  expect(splitTextRuns("See (https://en.wikipedia.org/wiki/Function_(mathematics)) done")).toEqual([
    { kind: "plain", value: "See (" },
    { kind: "link", value: "https://en.wikipedia.org/wiki/Function_(mathematics)" },
    { kind: "plain", value: ") done" },
  ]);
});

test("test_peels_quotes_and_period_off_link_run", () => {
  expect(splitTextRuns('Read "https://example.com/a".')).toEqual([
    { kind: "plain", value: 'Read "' },
    { kind: "link", value: "https://example.com/a" },
    { kind: "plain", value: '".' },
  ]);
});

test("test_peels_cjk_sentence_punctuation_off_link_run", () => {
  expect(splitTextRuns("見て https://example.com/a。 次")).toEqual([
    { kind: "plain", value: "見て " },
    { kind: "link", value: "https://example.com/a" },
    { kind: "plain", value: "。 次" },
  ]);
});

test("test_keeps_combining_mark_inside_hashtag_run", () => {
  expect(splitTextRuns("Tag #caf\u00E9 now")).toEqual([
    { kind: "plain", value: "Tag " },
    { kind: "hashtag", value: "#caf\u00E9" },
    { kind: "plain", value: " now" },
  ]);
  expect(splitTextRuns("Tag #cafe\u0301 now")).toEqual([
    { kind: "plain", value: "Tag " },
    { kind: "hashtag", value: "#cafe\u0301" },
    { kind: "plain", value: " now" },
  ]);
});

test("test_includes_year_in_short_date_when_other_year", () => {
  expect(formatShortDate(new Date(2020, 0, 2, 8, 30))).toBe("8:30 AM · Jan 2, 2020");
});

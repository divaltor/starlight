import { expect, test } from "bun:test";
import { Exa } from "@/ai/tools/exa";

test("blocks YouTube links from Exa fetches and searches", () => {
  const youtubeUrl = "https://www.youtube.com/watch?v=rD3G6Tj6i3M";

  expect(Exa.fetchUrl.safeParse(youtubeUrl).success).toBe(false);
  expect(Exa.searchQuery.safeParse(`summarize ${youtubeUrl}`).success).toBe(false);
  expect(Exa.fetchUrl.safeParse("https://example.com/article").success).toBe(true);
  expect(Exa.searchQuery.safeParse("current semiconductor news").success).toBe(true);
});

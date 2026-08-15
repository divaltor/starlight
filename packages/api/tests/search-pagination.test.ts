import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../src/types/tweets";
import { isSearchCursorPayload } from "../src/utils/cursor";
import { paginateSearchResults } from "../src/utils/search-pagination";

const row = (tweetId: string, photoId: string, finalScore: number): SearchResult => ({
	photo_id: photoId,
	original_url: `https://example.com/${photoId}.jpg`,
	s3_path: `photos/${photoId}.jpg`,
	username: "artist",
	tweet_id: tweetId,
	tweet_created_at: new Date("2026-01-01"),
	is_nsfw: false,
	height: 100,
	width: 100,
	final_score: finalScore,
});

describe("search post pagination", () => {
	test("keeps every media row for a post on the same page", () => {
		const page = paginateSearchResults(
			[
				row("post-1", "photo-1", 0.9),
				row("post-1", "photo-2", 0.9),
				row("post-2", "photo-3", 0.8),
				row("post-2", "photo-4", 0.8),
			],
			1,
		);

		expect(page.rows.map((result) => result.photo_id)).toEqual(["photo-1", "photo-2"]);
		expect(page.hasNextPage).toBe(true);
		expect(page.lastPost).toMatchObject({ tweet_id: "post-1", final_score: 0.9 });
	});

	test("does not create a cursor when the page contains exactly the limit", () => {
		const page = paginateSearchResults(
			[row("post-1", "photo-1", 0.9), row("post-1", "photo-2", 0.9)],
			1,
		);

		expect(page.hasNextPage).toBe(false);
		expect(page.rows).toHaveLength(2);
	});

	test("rejects obsolete media-level cursors", () => {
		expect(
			isSearchCursorPayload({
				lastScore: 0.9,
				lastPhotoId: "photo-1",
				queryTime: "2026-01-01T00:00:00.000Z",
			}),
		).toBe(false);
	});
});

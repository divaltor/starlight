import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../src/types/posts";
import { Cursor, SearchCursorPayloadSchema } from "../src/utils/cursor";
import { paginateSearchResults } from "../src/utils/search-pagination";

const row = (postId: string, mediaId: string, finalScore: number): SearchResult => ({
	media_id: mediaId,
	provider: "twitter",
	user_id: "user-1",
	kind: "image",
	original_url: `https://example.com/${mediaId}.jpg`,
	s3_path: `photos/${mediaId}.jpg`,
	username: "artist",
	post_id: postId,
	post_provider: "twitter",
	source_url: `https://example.com/posts/${postId}`,
	post_created_at: new Date("2026-01-01"),
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

		expect(page.rows.map((result) => result.media_id)).toEqual(["photo-1", "photo-2"]);
		expect(page.hasNextPage).toBe(true);
		expect(page.lastPost).toMatchObject({ post_id: "post-1", final_score: 0.9 });
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
			Cursor.parse(
				Cursor.create({
					lastScore: 0.9,
					lastPhotoId: "photo-1",
					queryTime: "2026-01-01T00:00:00.000Z",
				}),
				SearchCursorPayloadSchema,
			),
		).toBeNull();
	});
});

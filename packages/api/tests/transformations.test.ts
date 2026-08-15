import { describe, expect, test } from "bun:test";
import { transformSearchResultsPure } from "../src/utils/search-transformations";

describe("transformSearchResults", () => {
	test("does not merge colliding provider identifiers", () => {
		const shared = {
			photo_id: "1",
			original_url: "https://example.com/1.jpg",
			s3_path: "media/1.jpg",
			username: "artist",
			tweet_id: "1",
			source_url: "https://example.com/post/1",
			tweet_created_at: new Date("2026-01-01"),
			is_nsfw: false,
			height: 100,
			width: 100,
			final_score: 1,
		};
		const posts = transformSearchResultsPure(
			[
				{ ...shared, provider: "twitter", post_provider: "twitter" },
				{ ...shared, provider: "pixiv", post_provider: "pixiv" },
			],
			"https://cdn.example.com",
		);
		expect(posts).toHaveLength(2);
		expect(posts.map((post) => post.id)).toEqual(["1", "pixiv:1"]);
		expect(posts.at(0)).toMatchObject({
			id: "1",
			externalId: "1",
			photos: [{ id: "1", externalId: "1" }],
		});
		expect(posts.at(1)).toMatchObject({
			id: "pixiv:1",
			externalId: "1",
			photos: [{ id: "pixiv:1", externalId: "1" }],
		});
	});
});

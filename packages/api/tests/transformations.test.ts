import { describe, expect, test } from "bun:test";
import { transformSearchResultsPure } from "../src/utils/search-transformations";
import { createPublicId, parseMediaPublicId } from "../src/utils/public-id";
import { transformTweets } from "../src/utils/transformations";

describe("transformSearchResults", () => {
	test("uses identical public IDs in gallery and global search", () => {
		const createdAt = new Date("2026-01-01");
		const galleryPost = transformTweets([
			{
				id: "post:1",
				provider: "provider:one",
				userId: "owner:one",
				authorUsername: "artist",
				username: "artist",
				createdAt,
				sourceUrl: "https://example.com/post/1",
				photos: [
					{
						id: "media:1",
						provider: "provider:one",
						kind: "image",
						originalUrl: "https://example.com/1.jpg",
					},
				],
			},
		]).at(0);
		const searchPost = transformSearchResultsPure(
			[
				{
					media_id: "media:1",
					provider: "provider:one",
					user_id: "owner:one",
					original_url: "https://example.com/1.jpg",
					s3_path: "media/1.jpg",
					username: "artist",
					post_id: "post:1",
					post_provider: "provider:one",
					source_url: "https://example.com/post/1",
					post_created_at: createdAt,
					is_nsfw: false,
					height: 100,
					width: 100,
					final_score: 1,
				},
			],
			"https://cdn.example.com",
		).at(0);

		expect(galleryPost?.id).toBe(searchPost?.id);
		expect(galleryPost?.photos.at(0)?.id).toBe(searchPost?.photos.at(0)?.id);
		expect(galleryPost?.id).not.toBe(createPublicId("post", "provider:two", "post:1", "owner:one"));
		expect(galleryPost?.id).not.toBe(createPublicId("post", "provider:one", "post:1", "owner:two"));
	});

	test("does not merge colliding provider identifiers", () => {
		const shared = {
			media_id: "1",
			original_url: "https://example.com/1.jpg",
			s3_path: "media/1.jpg",
			username: "artist",
			post_id: "1",
			source_url: "https://example.com/post/1",
			post_created_at: new Date("2026-01-01"),
			is_nsfw: false,
			height: 100,
			width: 100,
			final_score: 1,
		};
		const posts = transformSearchResultsPure(
			[
				{ ...shared, provider: "twitter", post_provider: "twitter", user_id: "owner" },
				{ ...shared, provider: "pixiv", post_provider: "pixiv", user_id: "owner" },
			],
			"https://cdn.example.com",
		);
		expect(posts).toHaveLength(2);
		expect(new Set(posts.map((post) => post.id)).size).toBe(2);
		expect(posts.at(0)).toMatchObject({
			id: createPublicId("post", "twitter", "1", "owner"),
			externalId: "1",
			photos: [{ id: createPublicId("media", "twitter", "1", "owner"), externalId: "1" }],
		});
		expect(posts.at(1)).toMatchObject({
			id: createPublicId("post", "pixiv", "1", "owner"),
			externalId: "1",
			photos: [{ id: createPublicId("media", "pixiv", "1", "owner"), externalId: "1" }],
		});
	});

	test("does not merge identifiers shared by different owners", () => {
		const shared = {
			media_id: "same-media",
			provider: "twitter",
			original_url: "https://example.com/1.jpg",
			s3_path: "media/1.jpg",
			username: "artist",
			post_id: "same-post",
			post_provider: "twitter",
			source_url: "https://x.com/i/status/same-post",
			post_created_at: new Date("2026-01-01"),
			is_nsfw: false,
			height: 100,
			width: 100,
			final_score: 1,
		};
		const posts = transformSearchResultsPure(
			[
				{ ...shared, user_id: "owner-a" },
				{ ...shared, user_id: "owner-b" },
			],
			"https://cdn.example.com",
		);
		expect(posts).toHaveLength(2);
		expect(new Set(posts.map((post) => post.id)).size).toBe(2);
		expect(new Set(posts.flatMap((post) => post.photos.map((photo) => photo.id))).size).toBe(2);
		const firstPhotoId = posts.at(0)?.photos.at(0)?.id;
		expect(firstPhotoId).toBeDefined();
		if (!firstPhotoId) {
			throw new Error("Expected a transformed photo");
		}
		expect(parseMediaPublicId(firstPhotoId)).toEqual({
			provider: "twitter",
			externalId: "same-media",
			userId: "owner-a",
		});
	});

	test("keeps an identity stable regardless of neighboring collisions", () => {
		const row = {
			media_id: "media:with:separators",
			provider: "provider:with:separators",
			user_id: "owner-a",
			original_url: "https://example.com/1.jpg",
			s3_path: "media/1.jpg",
			username: "artist",
			post_id: "post:1",
			post_provider: "provider:with:separators",
			source_url: "https://example.com/post/1",
			post_created_at: new Date("2026-01-01"),
			is_nsfw: false,
			height: 100,
			width: 100,
			final_score: 1,
		};
		const collision = { ...row, user_id: "owner-b" };
		const alone = transformSearchResultsPure([row], "https://cdn.example.com").at(0);
		const besideCollision = transformSearchResultsPure(
			[row, collision],
			"https://cdn.example.com",
		).at(0);
		expect(alone?.id).toBe(besideCollision?.id);
		expect(alone?.photos.at(0)?.id).toBe(besideCollision?.photos.at(0)?.id);
		expect(parseMediaPublicId(alone?.photos.at(0)?.id ?? "")).toEqual({
			provider: "provider:with:separators",
			externalId: "media:with:separators",
			userId: "owner-a",
		});
	});

	test("parses legacy Twitter, Pixiv, and collision media IDs", () => {
		expect(parseMediaPublicId("123")).toEqual({ provider: "twitter", externalId: "123" });
		expect(parseMediaPublicId("pixiv:456")).toEqual({ provider: "pixiv", externalId: "456" });
		const oldCollision = `~${Buffer.from(
			JSON.stringify(["media", "twitter", "789", "owner"]),
		).toString("base64url")}`;
		expect(parseMediaPublicId(oldCollision)).toEqual({
			provider: "twitter",
			externalId: "789",
			userId: "owner",
		});
	});
});

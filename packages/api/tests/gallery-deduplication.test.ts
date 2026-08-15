import { describe, expect, test } from "bun:test";
import {
	galleryDedupeKey,
	selectGalleryRepresentatives,
	type GalleryDedupeCandidate,
} from "../src/utils/gallery-deduplication";

describe("gallery duplicate partitioning", () => {
	const candidate = (overrides: Partial<GalleryDedupeCandidate>): GalleryDedupeCandidate => ({
		userId: "user-a",
		perceptualHash: "same-asset",
		provider: "twitter",
		mediaId: "media-a",
		postId: "post-a",
		postCreatedAt: new Date("2025-01-01T00:00:00.000Z"),
		finalScore: 1,
		...overrides,
	});

	test("partitions same-user duplicates without hiding the same asset for another user", () => {
		const representatives = selectGalleryRepresentatives([
			candidate({ mediaId: "twitter-copy", provider: "twitter", finalScore: 0.8 }),
			candidate({ mediaId: "pixiv-copy", provider: "pixiv", finalScore: 0.9 }),
			candidate({ userId: "user-b", mediaId: "other-user-copy", finalScore: 0.7 }),
		]);

		expect(representatives.map((item) => item.mediaId).sort()).toEqual([
			"other-user-copy",
			"pixiv-copy",
		]);
	});

	test("uses a unique fallback key when an asset hash is unavailable", () => {
		expect(galleryDedupeKey(candidate({ perceptualHash: null, mediaId: "media-a" }))).toBe(
			'["twitter","media-a","user-a"]',
		);
		expect(galleryDedupeKey(candidate({ perceptualHash: null, mediaId: "media-b" }))).toBe(
			'["twitter","media-b","user-a"]',
		);
	});

	test("selects a deterministic representative when duplicate scores tie", () => {
		const representatives = selectGalleryRepresentatives([
			candidate({ mediaId: "media-a", provider: "twitter", finalScore: 0.9 }),
			candidate({ mediaId: "media-z", provider: "twitter", finalScore: 0.9 }),
		]);

		expect(representatives).toHaveLength(1);
		expect(representatives[0]?.mediaId).toBe("media-z");
	});
});

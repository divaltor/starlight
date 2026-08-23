import { beforeEach, describe, expect, mock, test } from "bun:test";

const findMany = mock();

mock.module("@starlight/utils", () => ({
	prisma: { media: { findMany } },
}));
mock.module("@/logger", () => ({
	logger: { debug: mock() },
}));

const { findSimilarPhotos } = await import("@/services/duplicate-detection");

const targetHash = "0000000000000000";

describe("findSimilarPhotos", () => {
	beforeEach(() => {
		findMany.mockReset();
	});

	test("returns matching assets from a full candidate bucket", async () => {
		findMany
			.mockResolvedValueOnce(
				Array.from({ length: 50 }, (_, index) => ({
					id: `media-${index}`,
					userId: "user",
					perceptualHash: targetHash,
					s3Path: `media/twitter/user/${index}.jpg`,
					originalUrl: `https://example.test/${index}.jpg`,
					postId: `post-${index}`,
					height: 100,
					width: 100,
					post: { sourceUrl: "https://example.test/post" },
				})),
			)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);

		const matches = await findSimilarPhotos(targetHash);

		expect(matches).toHaveLength(50);
		expect(matches[0]).toMatchObject({
			perceptualHash: targetHash,
			s3Path: "media/twitter/user/0.jpg",
		});
		expect(findMany.mock.calls.map(([query]) => query.take)).toEqual([50, 200, 1000]);
	});
});

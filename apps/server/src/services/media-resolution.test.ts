import { describe, expect, test } from "bun:test";
import { isMediaResolved, resolveMediaFromAsset } from "@/services/media-resolution";

describe("media asset resolution", () => {
	test("resolves a cross-user occurrence from an existing asset", () => {
		const asset = {
			s3Path: "media/twitter/owner/source.jpg",
			perceptualHash: "asset-content-hash",
			height: 1200,
			width: 800,
		};
		const occurrence = {
			id: "recipient-media",
			userId: "recipient",
			originalUrl: "https://provider.example/recipient-media.jpg",
		};

		expect({ ...occurrence, ...resolveMediaFromAsset(asset) }).toEqual({
			...occurrence,
			s3Path: "media/twitter/owner/source.jpg",
			perceptualHash: "asset-content-hash",
			height: 1200,
			width: 800,
		});
	});

	test("only considers assets resolved when their stored object is usable", () => {
		expect(
			isMediaResolved({
				kind: "image",
				s3Path: "media/twitter/user/image.jpg",
				perceptualHash: "hash",
			}),
		).toBe(true);
		expect(
			isMediaResolved({
				kind: "image",
				s3Path: "media/twitter/user/image.jpg",
				perceptualHash: null,
			}),
		).toBe(false);
		expect(
			isMediaResolved({
				kind: "video",
				s3Path: "media/twitter/user/video.mp4",
				perceptualHash: null,
			}),
		).toBe(true);
		expect(isMediaResolved({ kind: "video", s3Path: null, perceptualHash: null })).toBe(false);
	});
});

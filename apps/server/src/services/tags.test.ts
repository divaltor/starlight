import { describe, expect, test } from "bun:test";
import { normalizeCollectorTags, normalizeTags, normalizeTwitterTags } from "@/services/tags";

describe("normalizeTags", () => {
	test("trims, drops empty tags, and deterministically deduplicates", () => {
		expect(normalizeTags(["  anime ", "", "anime", " アニメ "])).toEqual(["anime", "アニメ"]);
	});

	test("maps scraper hashtags to normalized collector tags", () => {
		expect(normalizeTwitterTags({ hashtags: [" art ", "art", "創作"] })).toEqual(["art", "創作"]);
	});

	test("recovers validated hashtags from an old Twitter collector job", () => {
		expect(
			normalizeCollectorTags("twitter", undefined, {
				hashtags: [" art ", 42, null, "art", "創作"],
			}),
		).toEqual(["art", "創作"]);
		expect(normalizeCollectorTags("pixiv", undefined, { hashtags: ["ignored"] })).toEqual([]);
		expect(normalizeCollectorTags("twitter", ["valid", 42], {})).toEqual(["valid"]);
	});
});

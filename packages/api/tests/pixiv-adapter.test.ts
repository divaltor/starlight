import { describe, expect, test } from "bun:test";
import { normalizePixivTags } from "../src/services/pixiv";

describe("Pixiv adapter tags", () => {
	test("maps library tags to normalized domain strings", () => {
		expect(
			normalizePixivTags([
				{ name: "  original ", translatedName: null },
				{ name: "original", translatedName: "Original" },
				{ name: "創作", translatedName: null },
			]),
		).toEqual(["original", "創作"]);
	});
});

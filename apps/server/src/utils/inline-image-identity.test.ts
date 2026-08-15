import { describe, expect, test } from "bun:test";
import {
	createInlineImageDedupeKey,
	createInlineImageIdentityKey,
	createInlineImageResultId,
} from "@/utils/inline-image-identity";

describe("inline image identity", () => {
	test("is stable, compact, and provider/owner-safe", () => {
		const id = createInlineImageResultId("provider:one", "media:one", "owner:one");

		expect(createInlineImageResultId("provider:one", "media:one", "owner:one")).toBe(id);
		expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64);
		expect(createInlineImageResultId("provider:two", "media:one", "owner:one")).not.toBe(id);
		expect(createInlineImageResultId("provider:one", "media:one", "owner:two")).not.toBe(id);
		expect(createInlineImageIdentityKey("a:b", "c", "d")).not.toBe(
			createInlineImageIdentityKey("a", "b:c", "d"),
		);
		expect(createInlineImageDedupeKey("a", "media", "owner", "same")).not.toBe(
			createInlineImageDedupeKey("b", "media", "owner", "same"),
		);
	});
});

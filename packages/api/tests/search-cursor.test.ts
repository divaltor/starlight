import { describe, expect, test } from "bun:test";
import {
	isAfterSearchCursor,
	isSearchCursorPayload,
	type SearchCursorPayload,
} from "../src/utils/cursor";

const cursor: SearchCursorPayload = {
	lastScore: 0.8,
	lastProvider: "twitter",
	lastPostId: "10",
	lastUserId: "b",
	queryTime: "2026-01-01T00:00:00.000Z",
};

describe("search cursor ordering", () => {
	test("matches score/provider/post/user descending lexicographic order", () => {
		expect(
			isAfterSearchCursor({ finalScore: 0.7, provider: "z", postId: "99", userId: "z" }, cursor),
		).toBe(true);
		expect(
			isAfterSearchCursor(
				{ finalScore: 0.8, provider: "pixiv", postId: "99", userId: "z" },
				cursor,
			),
		).toBe(true);
		expect(
			isAfterSearchCursor(
				{ finalScore: 0.8, provider: "twitter", postId: "10", userId: "a" },
				cursor,
			),
		).toBe(true);
		expect(
			isAfterSearchCursor(
				{ finalScore: 0.8, provider: "twitter", postId: "09", userId: "z" },
				cursor,
			),
		).toBe(true);
		expect(
			isAfterSearchCursor(
				{ finalScore: 0.8, provider: "twitter", postId: "10", userId: "c" },
				cursor,
			),
		).toBe(false);
		expect(
			isAfterSearchCursor(
				{ finalScore: 0.8, provider: "twitter", postId: "10", userId: "b" },
				cursor,
			),
		).toBe(false);
	});

	test("rejects obsolete incomplete cursors", () => {
		expect(
			isSearchCursorPayload({ lastScore: 1, lastPhotoId: "1", queryTime: cursor.queryTime }),
		).toBe(false);
	});

	test("validates finite scores, non-empty identity, and canonical ISO query time", () => {
		expect(isSearchCursorPayload(cursor)).toBe(true);
		expect(isSearchCursorPayload({ ...cursor, queryTime: "January 1, 2026" })).toBe(false);
		expect(isSearchCursorPayload({ ...cursor, queryTime: "2026-02-30T00:00:00.000Z" })).toBe(false);
		expect(isSearchCursorPayload({ ...cursor, lastProvider: "" })).toBe(false);
		expect(isSearchCursorPayload({ ...cursor, lastProvider: "   " })).toBe(false);
		expect(isSearchCursorPayload({ ...cursor, lastPostId: "" })).toBe(false);
		expect(isSearchCursorPayload({ ...cursor, lastUserId: "" })).toBe(false);
		expect(isSearchCursorPayload({ ...cursor, lastScore: Number.NaN })).toBe(false);
		expect(isSearchCursorPayload({ ...cursor, lastScore: Number.POSITIVE_INFINITY })).toBe(false);
	});
});

import { describe, expect, mock, test } from "bun:test";
import { executePixivOperation } from "../src/services/pixiv-credential-operation";

describe("executePixivOperation", () => {
	test("persists a rotated token when the operation throws", async () => {
		const operationError = new Error("bookmark request failed");
		const client = { refreshToken: "rotated-token" };
		const persistToken = mock((_token: string) => Promise.resolve());

		await expect(
			executePixivOperation({
				client,
				originalToken: "original-token",
				migrated: false,
				operation: () => Promise.reject(operationError),
				persistToken,
			})
		).rejects.toBe(operationError);
		expect(persistToken).toHaveBeenCalledTimes(1);
		expect(persistToken).toHaveBeenCalledWith("rotated-token");
	});

	test("returns a successful result after persisting a rotated token", async () => {
		const client = { refreshToken: "rotated-token" };
		const persistToken = mock((_token: string) => Promise.resolve());

		const result = await executePixivOperation({
			client,
			originalToken: "original-token",
			migrated: false,
			operation: () => Promise.resolve("bookmarks"),
			persistToken,
		});

		expect(result).toBe("bookmarks");
		expect(persistToken).toHaveBeenCalledWith("rotated-token");
	});

	test("does not persist an unchanged token", async () => {
		const client = { refreshToken: "same-token" };
		const persistToken = mock((_token: string) => Promise.resolve());

		await executePixivOperation({
			client,
			originalToken: "same-token",
			migrated: false,
			operation: () => Promise.resolve("bookmarks"),
			persistToken,
		});

		expect(persistToken).not.toHaveBeenCalled();
	});

	test("preserves the operation error if persistence also fails", async () => {
		const operationError = new Error("bookmark request failed");
		const client = { refreshToken: "rotated-token" };

		await expect(
			executePixivOperation({
				client,
				originalToken: "original-token",
				migrated: false,
				operation: () => Promise.reject(operationError),
				persistToken: () => Promise.reject(new Error("database unavailable")),
			})
		).rejects.toBe(operationError);
	});
});

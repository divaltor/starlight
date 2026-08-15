import { describe, expect, mock, test } from "bun:test";
import { createPixivCredentialService } from "../src/services/pixiv-credential-core";

const state = {
	client: { refreshToken: "rotated-token" },
	persistToken: () => Promise.resolve({ count: 1 }),
};

const updateMatching = mock((_userId: string, _encryptedSecret: string, _replacement: string) =>
	state.persistToken(),
);
const withPixivClient = createPixivCredentialService({
	withLock: <T>(_userId: string, operation: () => Promise<T>) => operation(),
	find: () =>
		Promise.resolve({ credentialType: "refresh_token", encryptedSecret: "original-token" }),
	decryptScoped: (token) => token,
	decryptLegacy: (token) => token,
	connect: () => Promise.resolve(state.client),
	encrypt: (token) => token,
	updateMatching,
});

describe("withPixivClient", () => {
	test("persists a rotated token before starting the operation", async () => {
		state.client.refreshToken = "rotated-token";
		state.persistToken = () => Promise.resolve({ count: 1 });
		updateMatching.mockClear();

		const result = await withPixivClient("user", () => {
			expect(updateMatching).toHaveBeenCalledWith("user", "original-token", "rotated-token");
			return Promise.resolve("bookmarks");
		});

		expect(result).toBe("bookmarks");
	});

	test("does not start the operation when persistence fails", async () => {
		const persistenceError = new Error("database unavailable");
		state.client.refreshToken = "rotated-token";
		state.persistToken = () => Promise.reject(persistenceError);
		updateMatching.mockClear();
		const operation = mock(() => Promise.resolve("bookmarks"));

		await expect(withPixivClient("user", operation)).rejects.toBe(persistenceError);
		expect(operation).not.toHaveBeenCalled();
	});

	test("does not overwrite a concurrently changed credential", async () => {
		state.client.refreshToken = "rotated-token";
		state.persistToken = () => Promise.resolve({ count: 0 });
		updateMatching.mockClear();
		const operation = mock(() => Promise.resolve("bookmarks"));

		await expect(withPixivClient("user", operation)).rejects.toThrow(
			"Pixiv credential changed during token rotation",
		);
		expect(operation).not.toHaveBeenCalled();
	});
});

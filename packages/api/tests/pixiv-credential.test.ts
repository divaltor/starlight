import { describe, expect, mock, test } from "bun:test";
import { createPixivCredentialService } from "../src/services/pixiv-credential-core";

const state = {
	client: { refreshToken: "rotated-token" },
	persistToken: () => Promise.resolve<unknown>(undefined),
};

const update = mock((_userId: string, _encryptedSecret: string) => state.persistToken());
const withPixivClient = createPixivCredentialService({
	withLock: <T>(_userId: string, operation: () => Promise<T>) => operation(),
	find: () =>
		Promise.resolve({ credentialType: "refresh_token", encryptedSecret: "original-token" }),
	decryptScoped: (token) => token,
	decryptLegacy: (token) => token,
	connect: () => Promise.resolve(state.client),
	encrypt: (token) => token,
	update,
});

describe("withPixivClient", () => {
	test("preserves an operation error when persisting its rotated token fails", async () => {
		const operationError = new Error("bookmark request failed");
		const persistenceError = new Error("database unavailable");
		state.client.refreshToken = "rotated-token";
		state.persistToken = () => Promise.reject(persistenceError);
		update.mockClear();

		await expect(withPixivClient("user", () => Promise.reject(operationError))).rejects.toBe(
			operationError,
		);
		expect(update).toHaveBeenCalledTimes(1);
	});

	test("rejects with a persistence error after a successful operation", async () => {
		const persistenceError = new Error("database unavailable");
		state.client.refreshToken = "rotated-token";
		state.persistToken = () => Promise.reject(persistenceError);
		update.mockClear();

		await expect(withPixivClient("user", () => Promise.resolve("bookmarks"))).rejects.toBe(
			persistenceError,
		);
		expect(update).toHaveBeenCalledTimes(1);
	});
});

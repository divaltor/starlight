import { describe, expect, mock, test } from "bun:test";

const state = {
	client: { refreshToken: "rotated-token" },
	credential: { credentialType: "refresh_token", encryptedSecret: "original-token" },
	persistToken: () => Promise.resolve(),
};

const update = mock(() => state.persistToken());

mock.module("@starlight/crypto", () => ({
	CookieEncryption: class {
		decryptScoped(token: string) {
			return token;
		}

		encryptScoped(token: string) {
			return token;
		}
	},
}));

mock.module("@starlight/utils", () => ({
	env: { COOKIE_ENCRYPTION_KEY: "key", COOKIE_ENCRYPTION_SALT: "salt" },
	prisma: {
		$transaction: async (
			operation: (transaction: { $executeRaw: () => Promise<void> }) => Promise<unknown>,
		) => operation({ $executeRaw: () => Promise.resolve() }),
		providerCredential: {
			findUnique: () => Promise.resolve(state.credential),
			update,
		},
	},
}));

mock.module("../src/services/pixiv", () => ({
	PixivAdapter: { connect: () => Promise.resolve(state.client) },
}));

const { withPixivClient } = await import("../src/services/pixiv-credential");

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

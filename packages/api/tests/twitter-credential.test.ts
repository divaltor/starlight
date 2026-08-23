import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createPixivCredentialService } from "../src/services/pixiv-credential-core";
import { createTwitterCredentialService } from "../src/services/twitter-credential-core";

const userId = "user-id";
const telegramId = 42n;
const cookies = JSON.stringify([
	{ domain: ".x.com", key: "auth_token", value: "token" },
	{ domain: ".x.com", key: "twid", value: "u%3D123456" },
]);
const replacementCookies = JSON.stringify([
	{ domain: ".x.com", key: "auth_token", value: "replacement" },
	{ domain: ".x.com", key: "twid", value: "u%3D654321" },
]);
const firefoxCookies = JSON.stringify([
	{ "Host raw": "https://x.com/", "Name raw": "auth_token", "Content raw": "token" },
	{ "Host raw": "https://x.com/", "Name raw": "twid", "Content raw": "u%3D123456" },
]);
const normalizedFirefoxCookies = JSON.stringify([
	{ domain: "x.com", key: "auth_token", value: "token" },
	{ domain: "x.com", key: "twid", value: "u%3D123456" },
]);

describe("Twitter credential service", () => {
	let credential: {
		credentialType: string;
		encryptedSecret: string;
		provider: string;
		user: { telegramId: bigint };
	} | null;
	let concurrentAction: "delete" | "save" | undefined;

	beforeEach(() => {
		credential = {
			credentialType: "cookies",
			encryptedSecret: `legacy:${cookies}`,
			provider: "twitter",
			user: { telegramId },
		};
		concurrentAction = undefined;
	});

	const createService = () =>
		createTwitterCredentialService({
			find: () => Promise.resolve(credential),
			decrypt: (secret) => {
				if (secret === "corrupt") {
					throw new Error("invalid authentication tag");
				}
				return {
					data: secret.replace(/^(legacy|scoped):/, ""),
					usedLegacyEncryption: !secret.startsWith("scoped:"),
				};
			},
			encrypt: (cookies) => `scoped:${cookies}`,
			updateMatching: (_id, original, replacement) => {
				if (concurrentAction === "save") {
					credential = {
						credentialType: "cookies",
						encryptedSecret: `scoped:${replacementCookies}`,
						provider: "twitter",
						user: { telegramId },
					};
				} else if (concurrentAction === "delete") {
					credential = null;
				}
				if (!credential || credential.encryptedSecret !== original) {
					return Promise.resolve({ count: 0 });
				}
				credential.encryptedSecret = replacement;
				return Promise.resolve({ count: 1 });
			},
			deleteMatching: (_id, original) => {
				if (concurrentAction === "save") {
					credential = {
						credentialType: "cookies",
						encryptedSecret: `scoped:${replacementCookies}`,
						provider: "twitter",
						user: { telegramId },
					};
				} else if (concurrentAction === "delete") {
					credential = null;
				}
				if (!credential || credential.encryptedSecret !== original) {
					return Promise.resolve({ count: 0 });
				}
				credential = null;
				return Promise.resolve({ count: 1 });
			},
		});

	test("upgrades legacy encryption with compare-and-swap", async () => {
		expect(await createService().get(userId)).toBe(cookies);
		expect(credential?.encryptedSecret).toBe(`scoped:${cookies}`);
	});

	test("preserves valid plaintext legacy cookie JSON", async () => {
		if (credential) {
			credential.encryptedSecret = cookies;
		}

		expect(await createService().get(userId)).toBe(cookies);
		expect(credential?.encryptedSecret).toBe(`scoped:${cookies}`);
	});

	test("normalizes Firefox plaintext while retaining its original CAS value", async () => {
		if (credential) {
			credential.encryptedSecret = firefoxCookies;
		}

		expect(await createService().get(userId)).toBe(normalizedFirefoxCookies);
		expect(credential?.encryptedSecret).toBe(`scoped:${normalizedFirefoxCookies}`);
	});

	test("a concurrent save wins a legacy upgrade race", async () => {
		concurrentAction = "save";
		expect(await createService().get(userId)).toBe(replacementCookies);
		expect(credential?.encryptedSecret).toBe(`scoped:${replacementCookies}`);
	});

	test("a concurrent delete wins a legacy upgrade race", async () => {
		concurrentAction = "delete";
		expect(await createService().get(userId)).toBeUndefined();
		expect(credential).toBeNull();
	});

	test("rejects an invalid credential type", async () => {
		if (credential) {
			credential.credentialType = "refresh_token";
		}
		expect(await createService().get(userId)).toBeUndefined();
	});

	test("rejects an invalid provider", async () => {
		if (credential) {
			credential.provider = "pixiv";
		}
		expect(await createService().get(userId)).toBeUndefined();
	});

	test("removes a cryptographically corrupt credential", async () => {
		if (credential) {
			credential.encryptedSecret = "corrupt";
		}
		expect(await createService().get(userId)).toBeUndefined();
		expect(credential).toBeNull();
	});

	test.each(["not-hex-garbage", "abc123", '[{"domain":".x.com"'])(
		"removes malformed or truncated cookie data: %s",
		async (invalid) => {
			if (credential) {
				credential.encryptedSecret = invalid;
			}

			expect(await createService().get(userId)).toBeUndefined();
			expect(credential).toBeNull();
		},
	);

	test("a concurrent valid save wins corruption cleanup and is returned", async () => {
		if (credential) {
			credential.encryptedSecret = "not-hex-garbage";
		}
		concurrentAction = "save";

		expect(await createService().get(userId)).toBe(replacementCookies);
		expect(credential?.encryptedSecret).toBe(`scoped:${replacementCookies}`);
	});
});

describe("Pixiv credential service", () => {
	const state = {
		client: { refreshToken: "rotated-token" },
		lockActive: false,
		persistToken: () => Promise.resolve({ count: 1 }),
	};
	const updateMatching = mock((_userId: string, _encryptedSecret: string, _replacement: string) =>
		state.persistToken(),
	);
	const withPixivClient = createPixivCredentialService({
		withLock: async <T>(_userId: string, operation: () => Promise<T>) => {
			state.lockActive = true;
			try {
				return await operation();
			} finally {
				state.lockActive = false;
			}
		},
		find: () =>
			Promise.resolve({ credentialType: "refresh_token", encryptedSecret: "original-token" }),
		decryptScoped: (token) => token,
		decryptLegacy: (token) => token,
		connect: () => Promise.resolve(state.client),
		encrypt: (token) => token,
		updateMatching,
	});

	test("persists a rotated token before starting the operation", async () => {
		state.client.refreshToken = "rotated-token";
		state.persistToken = () => Promise.resolve({ count: 1 });
		updateMatching.mockClear();

		const result = await withPixivClient("user", () => {
			expect(state.lockActive).toBe(false);
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

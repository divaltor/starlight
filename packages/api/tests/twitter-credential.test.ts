import { beforeEach, describe, expect, test } from "bun:test";
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

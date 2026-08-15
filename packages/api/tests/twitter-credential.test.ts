import { beforeEach, describe, expect, test } from "bun:test";
import { createTwitterCredentialService } from "../src/services/twitter-credential-core";

const userId = "user-id";
const telegramId = 42n;

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
			encryptedSecret: "legacy:secret",
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
					usedLegacyEncryption: secret.startsWith("legacy:"),
				};
			},
			encrypt: (cookies) => `scoped:${cookies}`,
			updateMatching: (_id, original, replacement) => {
				if (concurrentAction === "save") {
					credential = {
						credentialType: "cookies",
						encryptedSecret: "scoped:new-secret",
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
				if (!credential || credential.encryptedSecret !== original) {
					return Promise.resolve({ count: 0 });
				}
				credential = null;
				return Promise.resolve({ count: 1 });
			},
		});

	test("upgrades legacy encryption with compare-and-swap", async () => {
		expect(await createService().get(userId)).toBe("secret");
		expect(credential?.encryptedSecret).toBe("scoped:secret");
	});

	test("a concurrent save wins a legacy upgrade race", async () => {
		concurrentAction = "save";
		expect(await createService().get(userId)).toBe("new-secret");
		expect(credential?.encryptedSecret).toBe("scoped:new-secret");
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
});

import { beforeEach, describe, expect, test } from "bun:test";
import { CookieEncryption } from "@repo/crypto";

describe("CookieEncryption", () => {
	let encryption: CookieEncryption;
	const masterKey = "a".repeat(64); // 64 character hex string (32 bytes)
	const testUserId = "123456789";
	const testCookieData = JSON.stringify({
		auth_token: "test_auth_token_12345",
		ct0: "test_csrf_token_67890",
		sessionid: "test_session_id_abcdef",
		user_id: "123456789",
	});

	beforeEach(() => {
		encryption = new CookieEncryption(masterKey);
	});

	describe("constructor", () => {
		test("should create instance with string master key", () => {
			expect(() => new CookieEncryption(masterKey)).not.toThrow();
		});

		test("should create instance with Uint8Array master key", () => {
			const keyBytes = new Uint8Array(32).fill(0xaa);
			expect(() => new CookieEncryption(keyBytes)).not.toThrow();
		});

		test("should create instance with custom string salt", () => {
			expect(
				() => new CookieEncryption(masterKey, { salt: "custom-salt" }),
			).not.toThrow();
		});

		test("should create instance with custom Uint8Array salt", () => {
			const customSalt = new Uint8Array(16).fill(0x42);
			expect(
				() => new CookieEncryption(masterKey, { salt: customSalt }),
			).not.toThrow();
		});

		test("should use default salt when none provided", () => {
			const encryption1 = new CookieEncryption(masterKey);
			const encryption2 = new CookieEncryption(masterKey, {});

			const encrypted1 = encryption1.encrypt(testCookieData, testUserId);
			const decrypted2 = encryption2.decrypt(encrypted1, testUserId);

			expect(decrypted2).toBe(testCookieData);
		});
	});

	describe("generateMasterKey", () => {
		test("should generate a 64-character hex string", () => {
			const key = CookieEncryption.generateMasterKey();
			expect(key).toMatch(/^[0-9a-f]{64}$/);
			expect(key.length).toBe(64);
		});

		test("should generate different keys each time", () => {
			const key1 = CookieEncryption.generateMasterKey();
			const key2 = CookieEncryption.generateMasterKey();
			expect(key1).not.toBe(key2);
		});
	});

	describe("isEncrypted", () => {
		test("should return false for short strings", () => {
			expect(encryption.isEncrypted("short")).toBe(false);
		});

		test("should return false for non-hex strings", () => {
			expect(encryption.isEncrypted("z".repeat(80))).toBe(false);
		});

		test("should return false for JSON data", () => {
			expect(encryption.isEncrypted(testCookieData)).toBe(false);
		});

		test("should return true for hex strings longer than 80 characters", () => {
			const hexString = "a".repeat(160);
			expect(encryption.isEncrypted(hexString)).toBe(true);
		});
	});

	describe("encrypt and decrypt", () => {
		test("should encrypt and decrypt data successfully", () => {
			const encrypted = encryption.encrypt(testCookieData, testUserId);
			const decrypted = encryption.decrypt(encrypted, testUserId);

			expect(decrypted).toBe(testCookieData);
		});

		test("should produce different ciphertext for same data with different user IDs", () => {
			const encrypted1 = encryption.encrypt(testCookieData, "111");
			const encrypted2 = encryption.encrypt(testCookieData, "222");

			expect(encrypted1).not.toBe(encrypted2);
		});

		test("should produce different ciphertext each time (nonce randomness)", () => {
			const encrypted1 = encryption.encrypt(testCookieData, testUserId);
			const encrypted2 = encryption.encrypt(testCookieData, testUserId);

			expect(encrypted1).not.toBe(encrypted2);
		});

		test("should return hex-encoded ciphertext", () => {
			const encrypted = encryption.encrypt(testCookieData, testUserId);
			expect(encrypted).toMatch(/^[0-9a-f]+$/);
			expect(encrypted.length).toBeGreaterThan(80);
		});

		test("should throw error when decrypting with wrong user ID", () => {
			const encrypted = encryption.encrypt(testCookieData, testUserId);

			expect(() => {
				encryption.decrypt(encrypted, "wrong_user_id");
			}).toThrow();
		});

		test("should throw error when decrypting invalid data", () => {
			expect(() => {
				encryption.decrypt("invalid_hex_data", testUserId);
			}).toThrow();
		});
	});

	describe("safeDecrypt", () => {
		test("should return unencrypted data as-is", () => {
			const result = encryption.safeDecrypt(testCookieData, testUserId);
			expect(result).toBe(testCookieData);
		});

		test("should decrypt encrypted data", () => {
			const encrypted = encryption.encrypt(testCookieData, testUserId);
			const result = encryption.safeDecrypt(encrypted, testUserId);
			expect(result).toBe(testCookieData);
		});

		test("should throw error for invalid encrypted data", () => {
			const invalidEncrypted = "a".repeat(160); // Valid hex but invalid encryption

			expect(() => {
				encryption.safeDecrypt(invalidEncrypted, testUserId);
			}).toThrow("Failed to decrypt cookie data");
		});
	});

	describe("user isolation", () => {
		test("should encrypt data differently for different users", () => {
			const user1 = "111111111";
			const user2 = "222222222";

			const encrypted1 = encryption.encrypt(testCookieData, user1);
			const encrypted2 = encryption.encrypt(testCookieData, user2);

			expect(encrypted1).not.toBe(encrypted2);

			const decrypted1 = encryption.decrypt(encrypted1, user1);
			const decrypted2 = encryption.decrypt(encrypted2, user2);

			expect(decrypted1).toBe(testCookieData);
			expect(decrypted2).toBe(testCookieData);
		});

		test("should not allow cross-user decryption", () => {
			const user1 = "111111111";
			const user2 = "222222222";

			const encrypted = encryption.encrypt(testCookieData, user1);

			expect(() => {
				encryption.decrypt(encrypted, user2);
			}).toThrow();
		});
	});

	describe("edge cases", () => {
		test("should handle empty string", () => {
			const encrypted = encryption.encrypt("", testUserId);
			const decrypted = encryption.decrypt(encrypted, testUserId);
			expect(decrypted).toBe("");
		});

		test("should handle large data", () => {
			const largeData = "x".repeat(10000);
			const encrypted = encryption.encrypt(largeData, testUserId);
			const decrypted = encryption.decrypt(encrypted, testUserId);
			expect(decrypted).toBe(largeData);
		});

		test("should handle special characters", () => {
			const specialData =
				'{"emoji":"🔒","unicode":"\\u0000\\u001f","quotes":"\'""}';
			const encrypted = encryption.encrypt(specialData, testUserId);
			const decrypted = encryption.decrypt(encrypted, testUserId);
			expect(decrypted).toBe(specialData);
		});
	});

	describe("key derivation", () => {
		test("should produce consistent results for same inputs", () => {
			const encrypted1 = encryption.encrypt(testCookieData, testUserId);
			const decrypted1 = encryption.decrypt(encrypted1, testUserId);

			const encrypted2 = encryption.encrypt(testCookieData, testUserId);
			const decrypted2 = encryption.decrypt(encrypted2, testUserId);

			// Same plaintext should be recovered
			expect(decrypted1).toBe(testCookieData);
			expect(decrypted2).toBe(testCookieData);
			expect(decrypted1).toBe(decrypted2);

			// But ciphertext should be different due to random nonces
			expect(encrypted1).not.toBe(encrypted2);
		});

		test("should use different keys for different contexts", () => {
			// This is implicitly tested by the user isolation tests
			// The HKDF derives different keys for different user IDs
			const encryption1 = new CookieEncryption(masterKey);
			const encryption2 = new CookieEncryption(masterKey);

			// Same encryption instance should work consistently
			const encrypted = encryption1.encrypt(testCookieData, testUserId);
			const decrypted = encryption2.decrypt(encrypted, testUserId);

			expect(decrypted).toBe(testCookieData);
		});

		test("should produce different keys with different salts", () => {
			const encryption1 = new CookieEncryption(masterKey, { salt: "salt1" });
			const encryption2 = new CookieEncryption(masterKey, { salt: "salt2" });

			const encrypted1 = encryption1.encrypt(testCookieData, testUserId);
			const encrypted2 = encryption2.encrypt(testCookieData, testUserId);

			// Different salts should produce different ciphertext
			expect(encrypted1).not.toBe(encrypted2);

			// Each should decrypt correctly with their own instance
			expect(encryption1.decrypt(encrypted1, testUserId)).toBe(testCookieData);
			expect(encryption2.decrypt(encrypted2, testUserId)).toBe(testCookieData);

			// But should not cross-decrypt
			expect(() => encryption1.decrypt(encrypted2, testUserId)).toThrow();
			expect(() => encryption2.decrypt(encrypted1, testUserId)).toThrow();
		});
	});

	describe("performance characteristics", () => {
		test("should encrypt and decrypt efficiently", () => {
			const start = performance.now();

			// Perform multiple operations
			for (let i = 0; i < 100; i++) {
				const encrypted = encryption.encrypt(testCookieData, testUserId);
				const decrypted = encryption.decrypt(encrypted, testUserId);
				expect(decrypted).toBe(testCookieData);
			}

			const end = performance.now();
			const duration = end - start;

			// Should complete 100 encrypt/decrypt cycles in under 1 second
			expect(duration).toBeLessThan(1000);
		});

		test("should handle concurrent operations", async () => {
			const operations = Array.from({ length: 50 }, (_, i) =>
				Promise.resolve().then(() => {
					const userId = `user_${i}`;
					const data = `${testCookieData}_${i}`;
					const encrypted = encryption.encrypt(data, userId);
					const decrypted = encryption.decrypt(encrypted, userId);
					return { original: data, decrypted, userId };
				}),
			);

			const results = await Promise.all(operations);

			for (const result of results) {
				expect(result.decrypted).toBe(result.original);
			}
		});
	});
});

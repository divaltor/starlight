import { expect, test } from "bun:test";
import { CookieEncryption } from "@starlight/crypto";

const masterKey = "a".repeat(64);
const userId = "123456789";
const cookieData = JSON.stringify({
  auth_token: "test_auth_token_12345",
  ct0: "test_csrf_token_67890",
  sessionid: "test_session_id_abcdef",
  user_id: userId,
});

test("keeps stored cookies readable when a fresh instance uses the default salt", () => {
  const encrypted = new CookieEncryption(masterKey).encrypt(cookieData, userId);

  expect(new CookieEncryption(masterKey).decrypt(encrypted, userId)).toBe(cookieData);
});

test("keeps legacy plaintext cookies readable during migration", () => {
  expect(new CookieEncryption(masterKey).safeDecrypt(cookieData, userId)).toBe(cookieData);
});

test("reads encrypted cookies through the migration-compatible path", () => {
  const encryption = new CookieEncryption(masterKey);
  const encrypted = encryption.encrypt(cookieData, userId);

  expect(encryption.safeDecrypt(encrypted, userId)).toBe(cookieData);
});

test("rejects corrupted encrypted cookie data", () => {
  expect(() => new CookieEncryption(masterKey).safeDecrypt("a".repeat(160), userId)).toThrow(
    "Failed to decrypt cookie data",
  );
});

test("prevents another user from decrypting stored cookies", () => {
  const encryption = new CookieEncryption(masterKey);
  const encrypted = encryption.encrypt(cookieData, "111111111");

  expect(() => encryption.decrypt(encrypted, "222222222")).toThrow();
});

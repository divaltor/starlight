import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import {
	bytesToHex,
	bytesToUtf8,
	hexToBytes,
	utf8ToBytes,
} from "@noble/ciphers/utils";
import { managedNonce, randomBytes } from "@noble/ciphers/webcrypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

/**
 * Cookie encryption utility using XChaCha20-Poly1305
 */
export class CookieEncryption {
	private masterKey: Uint8Array;
	private salt: Uint8Array;

	constructor(masterKey: string | Uint8Array, salt?: string | Uint8Array) {
		this.masterKey =
			typeof masterKey === "string" ? hexToBytes(masterKey) : masterKey;

		this.salt =
			typeof salt === "string"
				? utf8ToBytes(salt)
				: (salt ?? utf8ToBytes("starlight-cookie-salt-v1"));
	}

	/**
	 * Derive a unique key for a specific user
	 */
	private deriveKey(userId: string): Uint8Array {
		const info = utf8ToBytes(`cookie-encryption-${userId}`);
		return hkdf(sha256, this.masterKey, this.salt, info, 32);
	}

	/**
	 * Check if data appears to be encrypted (hex string with expected length)
	 */
	isEncrypted(data: string): boolean {
		// Encrypted data should be hex string with minimum length
		// XChaCha20-Poly1305 with managedNonce adds 24-byte nonce + 16-byte tag
		// So minimum encrypted length is (24 + 16) * 2 = 80 hex characters
		if (data.length < 80) return false;

		// Check if it's a valid hex string
		return /^[0-9a-fA-F]+$/.test(data);
	}

	/**
	 * Encrypt cookie data for a specific user
	 */
	encrypt(data: string, userId: string): string {
		const key = this.deriveKey(userId);
		const cipher = managedNonce(xchacha20poly1305)(key);
		const plaintext = utf8ToBytes(data);
		const ciphertext = cipher.encrypt(plaintext);
		return bytesToHex(ciphertext);
	}

	/**
	 * Decrypt cookie data for a specific user
	 */
	decrypt(encryptedHex: string, userId: string): string {
		const key = this.deriveKey(userId);
		const cipher = managedNonce(xchacha20poly1305)(key);
		const ciphertext = hexToBytes(encryptedHex);
		const plaintext = cipher.decrypt(ciphertext);
		return bytesToUtf8(plaintext);
	}

	/**
	 * Safely decrypt with fallback to unencrypted data
	 */
	safeDecrypt(data: string, userId: string): string {
		if (!this.isEncrypted(data)) {
			return data; // Return as-is if not encrypted (migration support)
		}

		try {
			return this.decrypt(data, userId);
		} catch (error) {
			throw new Error(
				`Failed to decrypt cookie data: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	/**
	 * Generate a secure master key (for setup)
	 */
	static generateMasterKey(): string {
		return bytesToHex(randomBytes(32));
	}
}

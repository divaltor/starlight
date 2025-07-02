import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";

interface CursorData {
	userId: number;
	lastTweetId: string;
	lastCreatedAt: string;
	direction: "forward" | "backward";
}

interface EncryptedCursor {
	iv: string;
	authTag: string;
	encrypted: string;
}

function deriveKey(secretKey: string): Uint8Array {
	// Derive a 32-byte key from the secret using SHA-256
	const keyBuffer = new TextEncoder().encode(
		secretKey.padEnd(32, "0").slice(0, 32),
	);
	return sha256(keyBuffer);
}

export const CursorPagination = {
	createCursor(data: CursorData, secretKey: string): string {
		const payload = JSON.stringify(data);
		const payloadBytes = new TextEncoder().encode(payload);

		// Generate random IV for each encryption
		const iv = randomBytes(12); // 96-bit IV for GCM
		const key = deriveKey(secretKey);

		const cipher = gcm(key, iv);
		const encrypted = cipher.encrypt(payloadBytes);

		// Extract the ciphertext and auth tag
		const ciphertext = encrypted.slice(0, -16);
		const authTag = encrypted.slice(-16);

		const cursor: EncryptedCursor = {
			iv: Buffer.from(iv).toString("hex"),
			authTag: Buffer.from(authTag).toString("hex"),
			encrypted: Buffer.from(ciphertext).toString("hex"),
		};

		return Buffer.from(JSON.stringify(cursor)).toString("base64url");
	},

	parseCursor(
		cursor: string,
		requestingUserId: number,
		secretKey: string,
	): CursorData | null {
		try {
			// Decode the cursor
			const decoded = Buffer.from(cursor, "base64url").toString();
			const parsed: EncryptedCursor = JSON.parse(decoded);

			// Decrypt the payload
			const iv = Buffer.from(parsed.iv, "hex");
			const authTag = Buffer.from(parsed.authTag, "hex");
			const ciphertext = Buffer.from(parsed.encrypted, "hex");

			const key = deriveKey(secretKey);

			// Combine ciphertext and auth tag for decryption
			const encryptedData = new Uint8Array(ciphertext.length + authTag.length);
			encryptedData.set(ciphertext);
			encryptedData.set(authTag, ciphertext.length);

			const cipher = gcm(key, iv);
			const decrypted = cipher.decrypt(encryptedData);

			const payload = new TextDecoder().decode(decrypted);
			const data: CursorData = JSON.parse(payload);

			// Verify user ownership
			if (data.userId !== requestingUserId) {
				return null; // Cursor doesn't belong to requesting user
			}

			return data;
		} catch {
			return null; // Invalid cursor format or decryption failed
		}
	},

	/**
	 * Create pagination info for API responses
	 */
	createPaginationInfo(
		tweets: Array<{ id: string; createdAt: Date }>,
		userId: number,
		hasMore: boolean,
		secretKey: string,
		direction: "forward" | "backward" = "forward",
	) {
		if (tweets.length < 2) {
			return {
				hasNextPage: false,
				hasPreviousPage: false,
				nextCursor: null,
				previousCursor: null,
			};
		}

		// biome-ignore lint/style/noNonNullAssertion: We know there are tweets
		const firstTweet = tweets.at(0)!;
		// biome-ignore lint/style/noNonNullAssertion: We know there are tweets
		const lastTweet = tweets.at(-1)!;

		return {
			hasNextPage: hasMore && direction === "forward",
			hasPreviousPage: direction === "backward" || tweets.length > 0,
			nextCursor: hasMore
				? CursorPagination.createCursor(
						{
							userId,
							lastTweetId: lastTweet.id,
							lastCreatedAt: lastTweet.createdAt.toISOString(),
							direction: "forward",
						},
						secretKey,
					)
				: null,
			previousCursor: CursorPagination.createCursor(
				{
					userId,
					lastTweetId: firstTweet.id,
					lastCreatedAt: firstTweet.createdAt.toISOString(),
					direction: "backward",
				},
				secretKey,
			),
		};
	},
};

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@monorepo/utils";

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

export const CursorPagination = {
	createCursor(data: CursorData): string {
		const payload = JSON.stringify(data);

		// Generate random IV for each encryption
		const iv = randomBytes(12); // 96-bit IV for GCM
		const cipher = createCipheriv(
			"aes-256-gcm",
			Buffer.from(env.SECRET_KEY.padEnd(32, "0").slice(0, 32)),
			iv,
		);

		let encrypted = cipher.update(payload, "utf8", "hex");
		encrypted += cipher.final("hex");

		const authTag = cipher.getAuthTag();

		const cursor: EncryptedCursor = {
			iv: iv.toString("hex"),
			authTag: authTag.toString("hex"),
			encrypted,
		};

		return Buffer.from(JSON.stringify(cursor)).toString("base64url");
	},

	parseCursor(cursor: string, requestingUserId: number): CursorData | null {
		try {
			// Decode the cursor
			const decoded = Buffer.from(cursor, "base64url").toString();
			const parsed: EncryptedCursor = JSON.parse(decoded);

			// Decrypt the payload
			const iv = Buffer.from(parsed.iv, "hex");
			const authTag = Buffer.from(parsed.authTag, "hex");
			const decipher = createDecipheriv(
				"aes-256-gcm",
				Buffer.from(env.SECRET_KEY.padEnd(32, "0").slice(0, 32)),
				iv,
			);

			decipher.setAuthTag(authTag);

			let decrypted = decipher.update(parsed.encrypted, "hex", "utf8");
			decrypted += decipher.final("utf8");

			const data: CursorData = JSON.parse(decrypted);

			// Verify user ownership
			if (data.userId !== requestingUserId) {
				return null; // Cursor doesn't belong to requesting user
			}

			return data;
		} catch (error) {
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
		direction: "forward" | "backward" = "forward",
	) {
		if (tweets.length === 0) {
			return {
				hasNextPage: false,
				hasPreviousPage: false,
				nextCursor: null,
				previousCursor: null,
			};
		}

		const firstTweet = tweets[0];
		const lastTweet = tweets[tweets.length - 1];

		return {
			hasNextPage: hasMore && direction === "forward",
			hasPreviousPage: direction === "backward" || tweets.length > 0,
			nextCursor: hasMore
				? CursorPagination.createCursor({
						userId,
						lastTweetId: lastTweet.id,
						lastCreatedAt: lastTweet.createdAt.toISOString(),
						direction: "forward",
					})
				: null,
			previousCursor: CursorPagination.createCursor({
				userId,
				lastTweetId: firstTweet.id,
				lastCreatedAt: firstTweet.createdAt.toISOString(),
				direction: "backward",
			}),
		};
	},
};

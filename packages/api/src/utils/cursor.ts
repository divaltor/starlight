export type CursorPayload = {
	lastTweetId: string;
	createdAt: string;
};

export const Cursor = {
	create(data: CursorPayload): string {
		return Buffer.from(JSON.stringify(data)).toString("base64url");
	},

	parse(cursor: string): CursorPayload | null {
		let decoded: string;
		try {
			decoded = Buffer.from(cursor, "base64url").toString();
		} catch {
			return null;
		}

		try {
			return JSON.parse(decoded);
		} catch {
			return null;
		}
	},
};

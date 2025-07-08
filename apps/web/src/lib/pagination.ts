export interface CursorData {
	lastTweetId: string;
	createdAt: string;
}

export const CursorPagination = {
	createCursor(data: CursorData): string {
		return Buffer.from(JSON.stringify(data)).toString("base64url");
	},

	parseCursor(cursor: string): CursorData | null {
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

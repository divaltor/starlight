export type CursorPayload = {
	lastTweetId: string;
	createdAt: string;
};

export type SearchCursorPayload = {
	lastScore: number;
	lastPhotoId: string;
	queryTime: string;
};

export const Cursor = {
	create<T = CursorPayload>(data: T): string {
		return Buffer.from(JSON.stringify(data)).toString("base64url");
	},

	parse<T = CursorPayload>(cursor: string): T | null {
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

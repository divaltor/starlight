export type CursorPayload = {
	lastTweetId: string;
	createdAt: string;
};

export type SearchCursorPayload = {
	lastScore: number;
	lastTweetId: string;
	queryTime: string;
};

export const isSearchCursorPayload = (value: unknown): value is SearchCursorPayload => {
	if (!value || typeof value !== "object") {
		return false;
	}
	const payload = value as Record<string, unknown>;
	return (
		typeof payload.lastScore === "number" &&
		Number.isFinite(payload.lastScore) &&
		typeof payload.lastTweetId === "string" &&
		payload.lastTweetId.length > 0 &&
		typeof payload.queryTime === "string" &&
		Number.isFinite(Date.parse(payload.queryTime))
	);
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

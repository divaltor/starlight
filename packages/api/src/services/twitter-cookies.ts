const TWID_REGEX = /u=(\d+)/;

export interface TwitterCookie {
	domain: string;
	key: string;
	value: string;
}

const isTwitterCookie = (value: unknown): value is TwitterCookie => {
	if (!value || typeof value !== "object") {
		return false;
	}

	const cookie = value as Record<string, unknown>;
	return (
		typeof cookie.domain === "string" &&
		typeof cookie.key === "string" &&
		cookie.key.length > 0 &&
		typeof cookie.value === "string"
	);
};

export const getTwitterUserId = (cookies: TwitterCookie[]): string | undefined => {
	const twid = cookies.find((cookie) => cookie.key === "twid")?.value;
	if (!twid) {
		return;
	}

	const match = decodeURIComponent(twid).match(TWID_REGEX);
	return match?.[1];
};

export const parseTwitterCookies = (data: string): TwitterCookie[] => {
	const parsed: unknown = JSON.parse(data);
	if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isTwitterCookie)) {
		throw new Error("Invalid Twitter cookies");
	}

	if (!getTwitterUserId(parsed)) {
		throw new Error("Twitter cookies do not contain a valid twid");
	}

	return parsed;
};

import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { z } from "zod/v4";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// Zod schema for Cookie Quick Manager format
const CookieQuickManagerSchema = z.array(
	z.object({
		"Host raw": z.string(),
		"Name raw": z.string(),
		"Content raw": z.string(),
	}),
);

/** Decode base64 text, returning null when the input is not valid base64. */
function tryBase64Decode(value: string): string | null {
	try {
		return atob(value);
	} catch {
		return null;
	}
}

interface Cookie {
	domain: string;
	key: string;
	value: string;
}

const DEFAULT_COOKIE_NAMES = ["auth_token", "ct0", "kdt", "twid"];

/** Outcome of trying to read a Cookie Quick Manager export out of decoded text. */
type QuickManagerRead =
	| { cookies: Cookie[]; state: "matched" }
	| { state: "json-other" }
	| { state: "not-json" };

/**
 * Interpret `text` (raw or base64-decoded) as JSON and, when it is a Cookie
 * Quick Manager export array, collect its target cookies.
 */
function readQuickManagerExport(text: string, targetNames: ReadonlySet<string>): QuickManagerRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { state: "not-json" };
	}

	const result = CookieQuickManagerSchema.safeParse(parsed);
	if (!result.success) {
		return { state: "json-other" };
	}

	const cookies: Cookie[] = [];
	for (const item of result.data) {
		const name = item["Name raw"];
		if (!targetNames.has(name)) {
			continue;
		}

		cookies.push({
			key: name,
			value: item["Content raw"],
			domain: item["Host raw"],
		});
	}
	return { cookies, state: "matched" };
}

/** Resolve a Quick Manager read attempt to final cookies or an RFC 6265 retry. */
function resolveCookieAttempt(
	text: string,
	attempt: QuickManagerRead,
	targetNames: ReadonlySet<string>,
): Cookie[] | null {
	switch (attempt.state) {
		case "matched": {
			return attempt.cookies.length > 0 ? attempt.cookies : null;
		}
		case "not-json": {
			// Not JSON, might be RFC 6265 format
			return parseRfc6265Cookies(text, targetNames);
		}
		default: {
			// Valid JSON of an unexpected shape
			return null;
		}
	}
}

/** Parse a single "name=value" segment, or undefined when it is not a target cookie. */
function parseCookieSegment(segment: string, targetNames: ReadonlySet<string>): Cookie | undefined {
	const trimmedPart = segment.trim();
	const segments = trimmedPart.split("=");

	if (trimmedPart.length === 0 || segments.length !== 2 || !targetNames.has(segments[0])) {
		return undefined;
	}

	return { key: segments[0], value: segments[1], domain: "" };
}

/** Parse an RFC 6265 cookie string (semicolon-separated pairs). */
function parseRfc6265Cookies(cookieString: string, targetNames: ReadonlySet<string>): Cookie[] {
	const cookies: Cookie[] = [];

	for (const part of cookieString.split(";")) {
		const cookie = parseCookieSegment(part, targetNames);
		if (cookie) {
			cookies.push(cookie);
		}
	}
	return cookies;
}

/**
 * Parse cookies from various formats using tough-cookie library
 * Supports: Cookie Quick Manager extension exports and RFC 6265 format (semicolon-separated)
 * @param value - Cookie data string
 * @param cookieNames - Array of cookie names to filter by. If undefined, defaults to ['auth_token', 'ct0', 'kdt', 'twid']
 * @returns Array of Cookie objects or null if invalid
 */
export function decodeCookies(value: string | null, cookieNames?: string[]): Cookie[] | null {
	if (!value?.trim()) {
		return null;
	}

	const targetNames = new Set(cookieNames ?? DEFAULT_COOKIE_NAMES);

	try {
		// Try to parse as base64 first; valid base64 input is interpreted via its decoded text.
		const decodedText = tryBase64Decode(value);

		if (decodedText !== null) {
			return resolveCookieAttempt(
				decodedText,
				readQuickManagerExport(decodedText, targetNames),
				targetNames,
			);
		}

		// Not base64: interpret the raw value itself.
		return resolveCookieAttempt(value, readQuickManagerExport(value, targetNames), targetNames);
	} catch {
		return null;
	}
}

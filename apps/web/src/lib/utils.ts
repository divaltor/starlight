import { type ClassValue, clsx } from "clsx";
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

const Base64StringSchema = z.string().refine(
	(val) => {
		try {
			atob(val);
			return true;
		} catch {
			return false;
		}
	},
	{ message: "Invalid base64 string" },
);

type Cookie = {
	key: string;
	value: string;
	domain: string;
};

/**
 * Parse cookies from various formats using tough-cookie library
 * Supports: Cookie Quick Manager extension exports and RFC 6265 format (semicolon-separated)
 * @param value - Cookie data string
 * @param cookieNames - Array of cookie names to filter by. If undefined, defaults to ['att', 'auth_token', 'ct0', 'kdt', 'twid']
 * @returns Array of Cookie objects or null if invalid
 */
export function decodeCookies(
	value: string | null,
	cookieNames?: string[],
): Cookie[] | null {
	if (!value || !value.trim()) {
		return null;
	}

	// Default cookie names if not specified
	const targetCookieNames = cookieNames ?? [
		"att",
		"auth_token",
		"ct0",
		"kdt",
		"twid",
	];
	const cookies: Cookie[] = [];

	try {
		let decoded: unknown;

		// Try to parse as base64 first
		const base64Result = Base64StringSchema.safeParse(value);
		if (base64Result.success) {
			try {
				const base64Decoded = atob(value);
				try {
					decoded = JSON.parse(base64Decoded);
				} catch {
					decoded = base64Decoded;
				}
			} catch {
				// If base64 decode fails, fall through to other parsing methods
				decoded = null;
			}
		} else {
			// Try parsing directly as JSON
			try {
				decoded = JSON.parse(value);
			} catch {
				// Not JSON, might be RFC 6265 format
				decoded = null;
			}
		}

		console.log("Decoded", decoded);

		// Try Cookie Quick Manager format first
		if (decoded) {
			const quickManagerResult = CookieQuickManagerSchema.safeParse(decoded);
			if (quickManagerResult.success) {
				for (const item of quickManagerResult.data) {
					const cookieName = item["Name raw"];
					// Filter by cookie names
					if (targetCookieNames.includes(cookieName)) {
						try {
							const cookie = {
								key: cookieName,
								value: item["Content raw"],
								domain: item["Host raw"],
							};
							cookies.push(cookie);
						} catch (error) {
							console.warn(
								"Failed to create cookie from Quick Manager format:",
								error,
							);
						}
					}
				}
				return cookies.length > 0 ? cookies : null;
			}
		}

		const cookiesToParse = (decoded as string | undefined) || value;

		// Try RFC 6265 format (semicolon-separated cookie string)
		// Split by semicolon and parse each cookie
		const cookieStrings = cookiesToParse
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);

		console.log("Cookie strings", cookieStrings);

		for (const cookieString of cookieStrings) {
			try {
				const cookie = cookieString.split("=");
				if (cookie.length !== 2) {
					continue;
				}

				const [key, value] = cookie;

				if (key && targetCookieNames.includes(key)) {
					cookies.push({
						key,
						value: value as string,
						domain: "",
					});
				}
			} catch (error) {
				console.warn(`Failed to parse cookie string "${cookieString}":`, error);
			}
		}

		console.log(cookies);

		return cookies.length > 0 ? cookies : null;
	} catch (error) {
		console.error("Error decoding cookies:", error);
		return null;
	}
}

export function cookiesToRfcString(cookies: Cookie[]): string {
	return cookies.map((cookie) => `${cookie.key}=${cookie.value}`).join("; ");
}

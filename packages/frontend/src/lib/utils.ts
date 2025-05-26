import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { z } from "zod";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// Zod schemas for different cookie formats
const CookieQuickManagerSchema = z.array(
	z
		.object({
			"Host raw": z.string(),
			"Name raw": z.string(),
			"Content raw": z.string(),
		})
		.passthrough(), // Allow additional properties
);

const StandardCookieObjectSchema = z.record(z.string(), z.string());

const CookieArraySchema = z.array(
	z
		.object({
			name: z.string(),
			value: z.string(),
		})
		.passthrough(), // Allow additional properties
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

/**
 * Decode and validate cookies from various formats using Zod schemas
 * Supports: base64 encoded JSON, raw JSON, Cookie Quick Manager extension exports
 * @param value - Cookie data string
 * @returns Record of cookie name-value pairs or null if invalid
 */
export function decodeCookies(
	value: string | null,
): Record<string, string> | null {
	if (!value || !value.trim()) {
		return null;
	}

	try {
		let decoded: unknown;

		// Try to parse as base64 first
		const base64Result = Base64StringSchema.safeParse(value);
		if (base64Result.success) {
			try {
				const base64Decoded = atob(value);
				decoded = JSON.parse(base64Decoded);
			} catch {
				// If base64 decode fails, fall through to JSON parsing
				decoded = JSON.parse(value);
			}
		} else {
			// Try parsing directly as JSON
			decoded = JSON.parse(value);
		}

		// Try Cookie Quick Manager format first
		const quickManagerResult = CookieQuickManagerSchema.safeParse(decoded);
		if (quickManagerResult.success) {
			const cookies: Record<string, string> = {};
			for (const item of quickManagerResult.data) {
				cookies[item["Name raw"]] = item["Content raw"];
			}
			return Object.keys(cookies).length > 0 ? cookies : null;
		}

		// Try standard cookie object format
		const standardResult = StandardCookieObjectSchema.safeParse(decoded);
		if (standardResult.success) {
			return Object.keys(standardResult.data).length > 0
				? standardResult.data
				: null;
		}

		// Try array format with name/value properties
		const arrayResult = CookieArraySchema.safeParse(decoded);
		if (arrayResult.success) {
			const cookies: Record<string, string> = {};
			for (const item of arrayResult.data) {
				cookies[item.name] = item.value;
			}
			return Object.keys(cookies).length > 0 ? cookies : null;
		}

		return null;
	} catch (error) {
		console.error("Error decoding cookies:", error);
		return null;
	}
}

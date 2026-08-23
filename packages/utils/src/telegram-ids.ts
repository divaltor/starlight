import { z } from "zod/v4";

/**
 * Comma-separated Telegram user IDs; group/supergroup chats are negative, so
 * a leading "-" is admitted only when allowNegative is set. Reports the exact
 * offending item through zod issues so boot failures name the variable.
 */
export function telegramIdList(envKey: string, { allowNegative = false } = {}) {
	const pattern = allowNegative ? /^-?\d+$/u : /^\d+$/u;

	return z
		.string()
		.default("")
		.transform((value, ctx) => {
			const ids: number[] = [];
			for (const item of [...new Set(value.split(",").map((id) => id.trim()))].filter(Boolean)) {
				const numericId = Number(item);
				if (!pattern.test(item) || !Number.isSafeInteger(numericId)) {
					ctx.addIssue({
						code: "custom",
						message: `${envKey} contains invalid Telegram ID: ${item}`,
					});
					return z.NEVER;
				}
				ids.push(numericId);
			}
			return ids;
		});
}

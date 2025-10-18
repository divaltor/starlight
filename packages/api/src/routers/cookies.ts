import { ORPCError } from "@orpc/client";
import { CookieEncryption } from "@starlight/crypto";
import { env } from "@starlight/utils";
import { z } from "zod";
import { maybeAuthProcedure, protectedProcedure } from "../middlewares/auth";

const cookiesSchema = z.object({
	cookies: z.string(),
});

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT
);

export const saveCookies = protectedProcedure
	.input(cookiesSchema)
	.route({ method: "POST" })
	.handler(async ({ input, context }) => {
		// Attempt to decode cookies; accept any non-empty string
		if (!input.cookies?.trim()) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid cookies",
				status: 400,
			});
		}

		// Encrypt and store under telegramId scoped key
		const encryptedCookies = cookieEncryption.encrypt(
			input.cookies,
			context.user.id.toString()
		);

		// biome-ignore lint/correctness/noUndeclaredVariables: Bun global redis instance
		await Bun.redis.set(`user:cookies:${context.user.id}`, encryptedCookies);
	});

export const verifyCookies = maybeAuthProcedure
	.route({ method: "GET" })
	.handler(async ({ context }) => {
		try {
			if (!context.user) {
				return { hasValidCookies: false };
			}

			// biome-ignore lint/correctness/noUndeclaredVariables: Bun global redis instance
			const storedCookies = await Bun.redis.get(
				`user:cookies:${context.user.id}`
			);

			if (!storedCookies) {
				return { hasValidCookies: false };
			}

			try {
				cookieEncryption.safeDecrypt(storedCookies, context.user.id.toString());
			} catch {
				// biome-ignore lint/correctness/noUndeclaredVariables: Bun global redis instance
				await Bun.redis.del(`user:cookies:${context.user.id}`);
				return { hasValidCookies: false };
			}

			return { hasValidCookies: true };
		} catch {
			return {
				hasValidCookies: false,
				error: "Failed to verify cookies",
			};
		}
	});

export const deleteCookies = protectedProcedure
	.route({ method: "DELETE" })
	.handler(async ({ context }) => {
		// biome-ignore lint/correctness/noUndeclaredVariables: Bun global redis instance
		await Bun.redis.del(`user:cookies:${context.user.id}`);
	});

import { ORPCError } from "@orpc/client";
import { CookieEncryption } from "@starlight/crypto";
import { env } from "@starlight/utils";
import { z } from "zod";
import { type AuthContext, protectedProcedure } from "../middlewares/auth";
import { redis } from "../utils/redis";

const cookiesSchema = z.object({
	cookies: z.string(),
});

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT
);

export const saveCookies = protectedProcedure
	.input(cookiesSchema)
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

		await redis.set(`user:cookies:${context.user.id}`, encryptedCookies);
	});

export const verifyCookies = async ({ context }: { context: AuthContext }) => {
	try {
		if (!context.user) {
			return { hasValidCookies: false };
		}

		const storedCookies = await redis.get(`user:cookies:${context.user.id}`);

		if (!storedCookies) {
			return { hasValidCookies: false };
		}

		try {
			cookieEncryption.safeDecrypt(storedCookies, context.user.id.toString());
		} catch {
			await redis.del(`user:cookies:${context.user.id}`);
			return { hasValidCookies: false };
		}

		return { hasValidCookies: true };
	} catch {
		return {
			hasValidCookies: false,
		};
	}
};

export const deleteCookies = protectedProcedure.handler(async ({ context }) => {
	await redis.del(`user:cookies:${context.user.id}`);
});

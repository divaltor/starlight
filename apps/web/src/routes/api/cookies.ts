import { createServerFn } from "@tanstack/react-start";
import { z } from "zod/v4";
import { bot, cookieEncryption, redis } from "@/lib/actions";
import { decodeCookies } from "@/lib/utils";
import { authMiddleware, optionalAuthMiddleware } from "@/middleware/auth";

const cookiesSchema = z.object({
	cookies: z.string(),
});

export const saveCookies = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(cookiesSchema)
	.handler(async ({ data, context }) => {
		const decodedCookies = decodeCookies(data.cookies);

		if (!decodedCookies) {
			return { success: false, error: "Invalid cookies" };
		}

		const encryptedCookies = cookieEncryption.encrypt(
			JSON.stringify(decodedCookies),
			context.user.id.toString(),
		);

		await redis.set(`user:cookies:${context.user.id}`, encryptedCookies);

		// TODO: Add inline keyboard
		await bot.api.sendMessage(
			context.user.id,
			"Beep boop, cookies are saved. You can now enable daily parsing using /queue command",
		);

		return { success: true };
	});

export const verifyCookies = createServerFn({ method: "POST" })
	.middleware([optionalAuthMiddleware])
	.handler(async ({ context }) => {
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

			return {
				hasValidCookies: true,
				twitterId: context.user.id.toString(),
			};
		} catch {
			return {
				hasValidCookies: false,
				error: "Failed to verify cookies",
			};
		}
	});

export const deleteCookies = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		await redis.del(`user:cookies:${context.user.id}`);

		return { success: true };
	});

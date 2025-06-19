import { decodeCookies } from "@/lib/utils";
import { CookieEncryption } from "@repo/crypto";
import { env } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import {
	setResponseHeaders,
	setResponseStatus,
} from "@tanstack/react-start/server";
import { parse, validate } from "@telegram-apps/init-data-node";
import { Bot } from "grammy";
import Redis from "ioredis";

interface CookiesRequest {
	// base64
	cookies: string;
	initData: string;
}

interface CookiesVerifyResponse {
	hasValidCookies: boolean;
	twitterId?: string;
	error?: string;
}

const redis = new Redis(env.REDIS_URL);
const bot = new Bot(env.BOT_TOKEN);
const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);

export const saveCookies = createServerFn({ method: "POST" })
	.validator((data: CookiesRequest) => data)
	.handler(async ({ data }) => {
		setResponseHeaders({ "Content-Type": "application/json" });

		if (!data.initData) {
			setResponseStatus(401);
			return { error: "Unauthorized" };
		}

		// On dev, we don't need to validate the init data
		if (env.ENVIRONMENT === "prod") {
			try {
				validate(data.initData, env.BOT_TOKEN);
			} catch (error) {
				setResponseStatus(400);
				return { error: "Invalid init data" };
			}
		}

		const parsedData = parse(data.initData);

		if (!parsedData.user) {
			setResponseStatus(400);
			return { error: "Invalid init data" };
		}

		const decodedCookies = decodeCookies(data.cookies);

		if (!decodedCookies) {
			setResponseStatus(400);
			return { error: "Invalid cookies" };
		}

		// Encrypt and store cookies in Redis
		const encryptedCookies = cookieEncryption.encrypt(
			JSON.stringify(decodedCookies),
			parsedData.user.id.toString(),
		);
		await redis.set(`user:cookies:${parsedData.user.id}`, encryptedCookies);


		await bot.api.sendMessage(
			parsedData.user.id,
			"Beep boop, cookies are saved. You can now enable daily parsing using /queue command",
		);

		return { success: true };
	});

export const verifyCookies = createServerFn({ method: "POST" })
	.validator((data: { initData: string }) => data)
	.handler(async ({ data }): Promise<CookiesVerifyResponse> => {
		try {
			if (!data.initData) {
				return { hasValidCookies: false, error: "No init data provided" };
			}

			// On dev, we don't need to validate the init data
			if (env.ENVIRONMENT === "prod") {
				try {
					validate(data.initData, env.BOT_TOKEN);
				} catch (error) {
					return { hasValidCookies: false, error: "Invalid init data" };
				}
			}

			const parsedData = parse(data.initData);

			if (!parsedData.user) {
				return { hasValidCookies: false, error: "Invalid init data" };
			}

			// Check if cookies exist in Redis
			const storedCookies = await redis.get(
				`user:cookies:${parsedData.user.id}`,
			);

			if (!storedCookies) {
				return { hasValidCookies: false };
			}

			// Test decryption to ensure cookies are valid
			try {
				cookieEncryption.safeDecrypt(
					storedCookies,
					parsedData.user.id.toString(),
				);
			} catch (error) {
				// Failed to decrypt, remove invalid cookies
				await redis.del(`user:cookies:${parsedData.user.id}`);
				return { hasValidCookies: false };
			}

			// Cookies are valid
			return {
				hasValidCookies: true,
				twitterId: parsedData.user.id.toString(),
			};
		} catch (error) {
			console.error("Error verifying cookies:", error);
			return { hasValidCookies: false, error: "Failed to verify cookies" };
		}
	});

export const deleteCookies = createServerFn({ method: "POST" })
	.validator((data: { initData: string }) => data)
	.handler(async ({ data }) => {
		try {
			if (!data.initData) {
				setResponseStatus(401);
				return { error: "Unauthorized" };
			}

			// On dev, we don't need to validate the init data
			if (env.ENVIRONMENT === "prod") {
				try {
					validate(data.initData, env.BOT_TOKEN);
				} catch (error) {
					setResponseStatus(400);
					return { error: "Invalid init data" };
				}
			}

			const parsedData = parse(data.initData);

			if (!parsedData.user) {
				setResponseStatus(400);
				return { error: "Invalid init data" };
			}

			// Delete cookies from Redis
			await redis.del(`user:cookies:${parsedData.user.id}`);

			return { success: true };
		} catch (error) {
			console.error("Error deleting cookies:", error);
			setResponseStatus(500);
			return { error: "Failed to delete cookies" };
		}
	});

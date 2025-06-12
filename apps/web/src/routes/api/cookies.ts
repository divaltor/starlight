import { decodeCookies } from "@/lib/utils";
import { env } from "@monorepo/utils";
import { createServerFn } from "@tanstack/react-start";
import {
	getCookie,
	setCookie,
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

		// Store cookies in Redis
		await redis.set(
			`user:cookies:${parsedData.user.id}`,
			JSON.stringify(decodedCookies),
		);

		// Set HTTP cookie for client-side verification
		const cookieData = {
			userId: parsedData.user.id,
			hasValidCookies: true,
			timestamp: Date.now(),
		};

		setCookie("twitter_auth", JSON.stringify(cookieData), {
			httpOnly: true,
			secure: env.ENVIRONMENT === "prod",
			sameSite: "strict",
			maxAge: 365 * 24 * 60 * 60, // 1 year
		});

		await bot.api.sendMessage(
			parsedData.user.id,
			"Beep boop, cookies are saved. You can now enable daily parsing using /queue command",
		);

		return { success: true };
	});

export const verifyCookies = createServerFn({ method: "GET" })
	.validator(() => ({}))
	.handler(async (): Promise<CookiesVerifyResponse> => {
		try {
			// Get the HTTP cookie
			const twitterAuthCookie = getCookie("twitter_auth");

			if (!twitterAuthCookie) {
				return { hasValidCookies: false };
			}

			const cookieData = JSON.parse(twitterAuthCookie);

			if (!cookieData.hasValidCookies || !cookieData.userId) {
				return { hasValidCookies: false };
			}

			// Verify cookies still exist in Redis
			const storedCookies = await redis.get(
				`user:cookies:${cookieData.userId}`,
			);

			if (!storedCookies) {
				// Cookies don't exist in Redis, clear the HTTP cookie
				setCookie("twitter_auth", "", {
					maxAge: 0,
				});
				return { hasValidCookies: false };
			}

			// Cookies are valid
			return {
				hasValidCookies: true,
				twitterId: cookieData.userId.toString(),
			};
		} catch (error) {
			console.error("Error verifying cookies:", error);
			return { hasValidCookies: false, error: "Failed to verify cookies" };
		}
	});

export const deleteCookies = createServerFn({ method: "POST" })
	.validator(() => ({}))
	.handler(async () => {
		try {
			// Get the HTTP cookie to identify the user
			const twitterAuthCookie = getCookie("twitter_auth");

			if (twitterAuthCookie) {
				const cookieData = JSON.parse(twitterAuthCookie);

				if (cookieData.userId) {
					// Delete cookies from Redis
					await redis.del(`user:cookies:${cookieData.userId}`);
				}
			}

			// Clear the HTTP cookie
			setCookie("twitter_auth", "", {
				maxAge: 0,
			});

			return { success: true };
		} catch (error) {
			console.error("Error deleting cookies:", error);
			setResponseStatus(500);
			return { error: "Failed to delete cookies" };
		}
	});

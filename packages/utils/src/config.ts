import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

const env = createEnv({
	server: {
		BOT_TOKEN: z.string(),

		REDIS_URL: z.url({ protocol: /^rediss?$/ }),
		DATABASE_URL: z.url({ protocol: /^postgresql$/ }),

		CORS_ORIGIN: z.string().default("http://localhost:3001"),

		COOKIE_ENCRYPTION_KEY: z
			.string()
			.min(
				64,
				"Cookie encryption key must be at least 64 characters (32 bytes hex)"
			),
		COOKIE_ENCRYPTION_SALT: z.string().min(16),

		YOUTUBE_DL_PATH: z.string().optional().default("yt-dlp"),

		AWS_ACCESS_KEY_ID: z.string(),
		AWS_SECRET_ACCESS_KEY: z.string(),
		AWS_ENDPOINT: z.string().optional(),

		AXIOM_BASE_URL: z.url().default("https://api.axiom.co"),
		AXIOM_DATASET: z.string().default("starlight"),
		AXIOM_TOKEN: z.string().optional(),

		NODE_ENV: z
			.enum(["development", "production"])
			.optional()
			.default("development"),

		LOG_LEVEL: z
			.enum(["trace", "debug", "info", "warn", "error", "fatal"])
			.optional(),

		OPENROUTER_API_KEY: z.string().optional(),
		OPENROUTER_MODEL: z.string().default("google/gemini-3-flash-preview"),

		BASE_FRONTEND_URL: z.string().default(process.env.VERCEL_URL || ""),
		BASE_CDN_URL: z
			.string()
			.transform((val) => {
				if (val) {
					return val;
				}

				const frontendUrl = process.env.BASE_FRONTEND_URL || "";

				if (!frontendUrl) {
					return "";
				}

				try {
					const url = new URL(
						frontendUrl.startsWith("http")
							? frontendUrl
							: `https://${frontendUrl}`
					);
					url.hostname = `cdn.${url.hostname}`;
					return url.toString();
				} catch {
					return frontendUrl;
				}
			})
			.optional()
			.default(""),
		DEFAULT_MEDIA_PATH: z.string().default("media/"),

		ML_BASE_URL: z.url().optional(),
		ML_API_TOKEN: z.string().optional(),

		ENABLE_CLASSIFICATION: z
			.string()
			.default("false")
			.transform((val) => z.stringbool().parse(val)),
		ENABLE_EMBEDDINGS: z
			.string()
			.default("false")
			.transform((val) => z.stringbool().parse(val)),

		PROXY_URLS: z.string().optional(),
	},
	clientPrefix: "VITE_",
	client: {
		VITE_SERVER_URL: z.string().default("http://localhost:3000"),
	},
	skipValidation: false,
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});

export function getRandomProxy(): string | undefined {
	if (!env.PROXY_URLS) {
		return;
	}

	const proxyUrls = env.PROXY_URLS.split(",")
		.map((url) => url.trim())
		.filter(Boolean);
	if (proxyUrls.length === 0) {
		return;
	}

	const randomIndex = Math.floor(Math.random() * proxyUrls.length);
	return proxyUrls[randomIndex];
}

export default env;

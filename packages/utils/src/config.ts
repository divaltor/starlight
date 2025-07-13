import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

const env = createEnv({
	server: {
		BOT_TOKEN: z.string(),

		REDIS_URL: z.url({ protocol: /^rediss?$/ }),
		DATABASE_URL: z.url({ protocol: /^postgresql$/ }),

		COOKIE_ENCRYPTION_KEY: z
			.string()
			.min(
				64,
				"Cookie encryption key must be at least 64 characters (32 bytes hex)",
			),
		COOKIE_ENCRYPTION_SALT: z.string().min(16),

		YOUTUBE_DL_PATH: z.string().optional().default("yt-dlp"),

		AWS_ACCESS_KEY_ID: z.string(),
		AWS_SECRET_ACCESS_KEY: z.string(),
		AWS_ENDPOINT: z.string().optional(),

		AXIOM_DATASET: z.string().optional(),
		AXIOM_TOKEN: z.string().optional(),

		ENVIRONMENT: z.enum(["dev", "prod"]).optional().default("dev"),

		BASE_FRONTEND_URL: z.string().default(process.env.VERCEL_URL || ""),
		BASE_CDN_URL: z
			.string()
			.transform((val) => {
				if (val) return val;

				const frontendUrl =
					process.env.VERCEL_URL || process.env.BASE_FRONTEND_URL || "";

				if (!frontendUrl) return "";

				try {
					const url = new URL(
						frontendUrl.startsWith("http")
							? frontendUrl
							: `https://${frontendUrl}`,
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

		INSTAGRAM_COOKIES: z.string().optional(),
	},
	skipValidation: false,
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});

export default env;

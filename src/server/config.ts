import dotenv from "dotenv";
import { z } from "zod/v4";

dotenv.config({ path: ".env" });

const envSchema = z.object({
	BOT_TOKEN: z.string(),
	ENVIRONMENT: z.enum(["dev", "prod"]).optional().default("dev"),
	REDIS_URL: z.url({ protocol: /^rediss?$/ }),
	DATABASE_URL: z.url({ protocol: /^postgresql$/ }),
	LOG_LEVEL: z
		.enum(["debug", "info", "warn", "error"])
		.optional()
		.default("debug"),
	YOUTUBE_DL_PATH: z.string().optional().default("yt-dlp"),
	AWS_ACCESS_KEY_ID: z.string(),
	AWS_SECRET_ACCESS_KEY: z.string(),
	AWS_ENDPOINT: z.string().optional(),
	BASE_CDN_URL: z.string(),
	BASE_FRONTEND_URL: z.string(),
});

const env = envSchema.parse(process.env);

declare global {
	namespace NodeJS {
		interface ProcessEnv extends z.infer<typeof envSchema> {}
	}
}

export default env;

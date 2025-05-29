import dotenv from "dotenv";
import { z } from "zod/v4";

dotenv.config({ path: ".env" });

const envSchema = z.object({
	BOT_TOKEN: z.string(),
	ENVIRONMENT: z.enum(["dev", "prod"]).optional().default("dev"),
	REDIS_URI: z.url({ protocol: /^rediss?$/ }),
	LOG_LEVEL: z
		.enum(["debug", "info", "warn", "error"])
		.optional()
		.default("debug"),
	YOUTUBE_DL_PATH: z.string().optional().default("yt-dlp"),
});

const env = envSchema.parse(process.env);

declare global {
	namespace NodeJS {
		interface ProcessEnv extends z.infer<typeof envSchema> {}
	}
}

export default env;
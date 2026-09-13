import { createEnv } from "@t3-oss/env-core";
import { telegramIdList } from "@starlight/utils/telegram-ids";
import { z } from "zod/v4";

const env = createEnv({
  server: {
    BOT_TOKEN: z.string(),

    DATABASE_URL: z.url({ protocol: /^postgresql$/u }),
    REDIS_URL: z.url({ protocol: /^rediss?$/u }),

    COOKIE_ENCRYPTION_KEY: z.string().min(64, "Cookie encryption key must be at least 64 characters (32 bytes hex)"),
    COOKIE_ENCRYPTION_SALT: z.string().min(16),

    YOUTUBE_DL_PATH: z.string().default("yt-dlp"),

    AWS_ACCESS_KEY_ID: z.string(),
    AWS_SECRET_ACCESS_KEY: z.string(),
    AWS_ENDPOINT: z.string().optional(),

    NODE_ENV: z.enum(["development", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),

    ML_BASE_URL: z.url().optional(),
    ML_API_TOKEN: z.string().optional(),
    ENABLE_CLASSIFICATION: z.stringbool().default(false),
    ENABLE_EMBEDDINGS: z.stringbool().default(false),

    SUPERVISOR_IDS: telegramIdList("SUPERVISOR_IDS"),
    WHITELIST_CHAT_IDS: telegramIdList("WHITELIST_CHAT_IDS", { allowNegative: true }),

    BASE_FRONTEND_URL: z.string().default(""),
    BASE_CDN_URL: z
      .string()
      .transform((value) => {
        if (value) return value;
        if (!process.env.BASE_FRONTEND_URL) return "";

        try {
          const url = new URL(
            process.env.BASE_FRONTEND_URL.startsWith("http")
              ? process.env.BASE_FRONTEND_URL
              : `https://${process.env.BASE_FRONTEND_URL}`,
          );
          url.hostname = `cdn.${url.hostname}`;
          return url.toString();
        } catch {
          return process.env.BASE_FRONTEND_URL;
        }
      })
      .default(""),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: false,
});

export default env;

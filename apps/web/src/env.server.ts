import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

const env = createEnv({
  server: {
    BOT_TOKEN: z.string(),

    CORS_ORIGIN: z.string().default("http://localhost:3001"),

    COOKIE_ENCRYPTION_KEY: z.string().min(64, "Cookie encryption key must be at least 64 characters (32 bytes hex)"),
    COOKIE_ENCRYPTION_SALT: z.string().min(16),

    NODE_ENV: z.enum(["development", "production"]).default("development"),

    ML_BASE_URL: z.url().optional(),
    ML_API_TOKEN: z.string().optional(),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    OTEL_EXPORTER_OTLP_HEADERS: z.string().default(""),

    BASE_CDN_URL: z.string().default(""),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: false,
});

export default env;

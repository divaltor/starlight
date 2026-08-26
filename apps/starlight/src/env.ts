import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";
import { telegramIdList } from "@starlight/utils/telegram-ids";

export interface LangfuseConfig {
  readonly baseUrl: string;
  readonly environment?: string;
  readonly publicKey: string;
  readonly secretKey: string;
}

export interface OtlpConfig {
  readonly endpoint: string;
  readonly headers: Record<string, string>;
}

/**
 * Environment surface of the Starlight bot, declared once and validated at
 * import. Factory-shaped so tests can feed a synthetic environment instead of
 * mutating process.env.
 */
export function createBotEnv(runtimeEnv: NodeJS.ProcessEnv = process.env) {
  const raw = createEnv({
    server: {
      STARLIGHT_BOT_TOKEN: z.string(),
      WHITELIST_CHAT_IDS: telegramIdList("WHITELIST_CHAT_IDS", { allowNegative: true }),
      WHITELIST_DM_USER_IDS: telegramIdList("WHITELIST_DM_USER_IDS"),

      DATABASE_URL: z.url({ protocol: /^postgresql$/u }),
      REDIS_URL: z.url({ protocol: /^rediss?$/u }),

      CONVERSATION_AFFINITY_SECRET: z.string().min(32),
      CONVERSATION_QUEUE_PREFIX: z.string().default("starlight-conversation"),
      CONVERSATION_BATCH_QUIET_MS: z.coerce.number().int().positive().default(1000),
      CONVERSATION_BATCH_MAX_WAIT_MS: z.coerce.number().int().positive().default(3000),
      CONVERSATION_LANE_LEASE_MS: z.coerce.number().int().positive().default(180_000),

      CONTEXT_SOFT_TOKEN_CAP: z.coerce.number().int().positive().default(24_000),
      CONTEXT_HARD_TOKEN_CAP: z.coerce.number().int().positive().default(48_000),
      CONTEXT_RETAINED_TOKEN_TARGET: z.coerce.number().int().positive().default(8000),
      CONTEXT_OUTPUT_RESERVE_TOKENS: z.coerce.number().int().nonnegative().default(1024),
      CONTEXT_TOOL_RESERVE_TOKENS: z.coerce.number().int().nonnegative().default(4096),
      CONTEXT_ESTIMATE_SAFETY_RATIO: z.coerce.number().min(1).default(1.15),

      // Internal Docker service discovery does not terminate TLS.
      // oxlint-disable-next-line sonarjs/no-clear-text-protocols
      HINDSIGHT_BASE_URL: z.url().default("http://hindsight:8888"),
      HINDSIGHT_API_KEY: z.string(),

      AWS_ACCESS_KEY_ID: z.string(),
      AWS_SECRET_ACCESS_KEY: z.string(),
      AWS_ENDPOINT: z.string().optional(),

      NODE_ENV: z.enum(["development", "production"]).default("development"),
      LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),

      LANGFUSE_PUBLIC_KEY: z.string().optional(),
      LANGFUSE_SECRET_KEY: z.string().optional(),
      LANGFUSE_BASE_URL: z.url().default("https://cloud.langfuse.com"),
      LANGFUSE_TRACING_ENVIRONMENT: z.string().optional(),

      OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
      OTEL_EXPORTER_OTLP_HEADERS: z.string().default(""),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
    skipValidation: false,
  });
  return {
    ...raw,
    langfuse: resolveLangfuse(raw),
    otlp: resolveOtlp(raw),
  };
}

/** Tracing enables only when both Langfuse keys are present. */
function resolveLangfuse(raw: {
  NODE_ENV: "development" | "production";
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL: string;
  LANGFUSE_TRACING_ENVIRONMENT?: string;
}): LangfuseConfig | undefined {
  if (!raw.LANGFUSE_PUBLIC_KEY || !raw.LANGFUSE_SECRET_KEY) return undefined;

  return {
    publicKey: raw.LANGFUSE_PUBLIC_KEY,
    secretKey: raw.LANGFUSE_SECRET_KEY,
    baseUrl: raw.LANGFUSE_BASE_URL,
    environment: raw.LANGFUSE_TRACING_ENVIRONMENT ?? raw.NODE_ENV,
  };
}

// Standard OpenTelemetry variables, so any OTLP/HTTP backend works (SigNoz, an
// OpenTelemetry Collector, ...). Headers use the spec format: "key=value,key2=value2".
function parseOtlpHeaders(rawHeaders: string): Record<string, string> {
  return Object.fromEntries(
    rawHeaders.split(",").flatMap((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 1) return [];
      const key = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      return key.length > 0 && value.length > 0 ? [[key, value] as const] : [];
    }),
  );
}

function resolveOtlp(raw: {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS: string;
}): OtlpConfig | undefined {
  if (!raw.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;

  return {
    endpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: parseOtlpHeaders(raw.OTEL_EXPORTER_OTLP_HEADERS),
  };
}

export type BotEnv = ReturnType<typeof createBotEnv>;

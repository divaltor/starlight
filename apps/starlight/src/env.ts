import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

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

      DATABASE_URL: z.url({ protocol: /^postgresql$/u }),
      REDIS_URL: z.url({ protocol: /^rediss?$/u }),

      CONVERSATION_QUEUE_PREFIX: z.string().default("starlight-conversation"),
      CONVERSATION_BATCH_QUIET_MS: z.coerce.number().int().positive().default(1000),
      CONVERSATION_BATCH_MAX_WAIT_MS: z.coerce.number().int().positive().default(3000),
      CONVERSATION_LANE_LEASE_MS: z.coerce.number().int().positive().default(180_000),
      MEMORY_RETENTION_IDLE_MS: z.coerce.number().int().positive().default(900_000),
      MEMORY_RETENTION_MAX_PENDING_CHARS: z.coerce.number().int().positive().default(8000),

      // Reject/compact a prepared request once it exceeds this size; keep reply headroom below the model limit.
      CONTEXT_COMPACTION_TRIGGER_TOKENS: z.coerce.number().int().positive().default(28_000),
      // Amount of recent and relevant context a checkpoint aims to preserve.
      CONTEXT_RETAINED_TOKEN_TARGET: z.coerce.number().int().positive().default(6000),

      // Internal Docker service discovery does not terminate TLS.
      // oxlint-disable-next-line sonarjs/no-clear-text-protocols
      HINDSIGHT_BASE_URL: z.url().default("http://hindsight:8888"),
      HINDSIGHT_API_KEY: z.string(),

      OPENROUTER_API_KEY: z.string().trim().min(1),

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
    // Tracing enables only when both Langfuse keys are present.
    langfuse:
      raw.LANGFUSE_PUBLIC_KEY && raw.LANGFUSE_SECRET_KEY
        ? {
            publicKey: raw.LANGFUSE_PUBLIC_KEY,
            secretKey: raw.LANGFUSE_SECRET_KEY,
            baseUrl: raw.LANGFUSE_BASE_URL,
            environment: raw.LANGFUSE_TRACING_ENVIRONMENT ?? raw.NODE_ENV,
          }
        : undefined,
    otlp: raw.OTEL_EXPORTER_OTLP_ENDPOINT
      ? {
          endpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT,
          headers: parseOtlpHeaders(raw.OTEL_EXPORTER_OTLP_HEADERS),
        }
      : undefined,
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

export type BotEnv = ReturnType<typeof createBotEnv>;

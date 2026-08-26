import { isSpanContextValid, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecord } from "@opentelemetry/api-logs";
import { Layer, Logger, ManagedRuntime, pipe, References } from "effect";
import type { LogLevel } from "effect/LogLevel";
import { Model } from "@/ai/model";
import { Conversation } from "@/conversation/conversation";
import { TelegramDelivery } from "@/conversation/delivery";
import { WakeOutbox } from "@/conversation/wake-outbox";
import { WakeQueue } from "@/conversation/wake-queue";
import { ConversationContext } from "@/context/context";
import { createBotEnv } from "@/env";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Memory } from "@/memory/memory";
import { Media } from "@/media/media";
import { Database } from "@/services/database";
import { Exa } from "@/services/exa";

const env = createBotEnv();

// Effect log levels mapped onto OpenTelemetry severity families.
const SEVERITY: Record<string, SeverityNumber> = {
  TRACE: SeverityNumber.TRACE,
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  FATAL: SeverityNumber.FATAL,
};

const LOG_LEVELS: Record<string, LogLevel> = {
  debug: "Debug",
  error: "Error",
  fatal: "Fatal",
  info: "Info",
  trace: "Trace",
  warn: "Warn",
};

function parseLogLevel(name: string): LogLevel {
  return LOG_LEVELS[name.toLowerCase()] ?? "Info";
}

// Emits structured records straight to the global OTel LoggerProvider; a no-op
// until initTelemetry registers one.
type StructuredLogOutput = ReturnType<(typeof Logger.formatStructured)["log"]>;

function otelSink(): Logger.Logger<unknown, void> {
  const otel = logs.getLogger("starlight-bot");

  function emitLogRecord(output: StructuredLogOutput): void {
    const message = Array.isArray(output.message) ? output.message.join(" ") : String(output.message);
    otel.emit({
      severityNumber: SEVERITY[output.level] ?? SeverityNumber.INFO,
      severityText: output.level,
      body: message,
      timestamp: Date.parse(output.timestamp),
      context: activeTraceContext(),
      attributes: {
        ...output.annotations,
        cause: output.cause,
        fiberId: output.fiberId,
        spans: output.spans,
      },
    } satisfies LogRecord);
  }

  return pipe(Logger.formatStructured, Logger.map(emitLogRecord));
}

// Attaches the active span so SigNoz links the log to its trace.
function activeTraceContext(): Context | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? trace.setSpanContext(ROOT_CONTEXT, spanContext) : undefined;
}

const production = env.NODE_ENV === "production";

const infrastructure = Layer.mergeAll(
  Database.layer(env.DATABASE_URL),
  Exa.defaultLayer,
  Model.defaultLayer,
  TelegramDelivery.layer(env.STARLIGHT_BOT_TOKEN),
  WakeQueue.layer(env.REDIS_URL, env.CONVERSATION_QUEUE_PREFIX),
  Hindsight.layer({ apiKey: env.HINDSIGHT_API_KEY, baseUrl: env.HINDSIGHT_BASE_URL }),
  Media.layer({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    endpoint: env.AWS_ENDPOINT,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    telegramToken: env.STARLIGHT_BOT_TOKEN,
  }),
  Conversation.optionsLayer({
    contextEstimateSafetyRatio: env.CONTEXT_ESTIMATE_SAFETY_RATIO,
    contextHardTokenCap: env.CONTEXT_HARD_TOKEN_CAP,
    contextOutputReserveTokens: env.CONTEXT_OUTPUT_RESERVE_TOKENS,
    contextRetainedTokenTarget: env.CONTEXT_RETAINED_TOKEN_TARGET,
    contextSoftTokenCap: env.CONTEXT_SOFT_TOKEN_CAP,
    contextToolReserveTokens: env.CONTEXT_TOOL_RESERVE_TOKENS,
    leaseMs: env.CONVERSATION_LANE_LEASE_MS,
    maxWaitMs: env.CONVERSATION_BATCH_MAX_WAIT_MS,
    quietMs: env.CONVERSATION_BATCH_QUIET_MS,
    whitelistedDmUserIds: env.WHITELIST_DM_USER_IDS,
  }),
);
const hindsightRetention = HindsightRetention.layer.pipe(Layer.provideMerge(infrastructure));
const memory = Memory.layer.pipe(Layer.provideMerge(hindsightRetention), Layer.provideMerge(infrastructure));
const context = ConversationContext.layer.pipe(Layer.provideMerge(memory), Layer.provideMerge(infrastructure));
const conversation = Conversation.layer.pipe(
  Layer.provideMerge(context),
  Layer.provideMerge(memory),
  Layer.provideMerge(infrastructure),
);
const outbox = WakeOutbox.layer.pipe(Layer.provideMerge(infrastructure));
const domain = Layer.mergeAll(infrastructure, memory, hindsightRetention, context, conversation, outbox);
const background = Layer.mergeAll(
  WakeOutbox.publisherLayer,
  WakeQueue.workerLayer(env.REDIS_URL, env.CONVERSATION_QUEUE_PREFIX),
  HindsightRetention.workerLayer,
).pipe(Layer.provideMerge(domain));

export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([
      production ? Logger.consoleJson : Logger.consolePretty(),
      ...(env.otlp === undefined ? [] : [otelSink()]),
      Logger.tracerLogger,
    ]),
    Layer.succeed(References.MinimumLogLevel)(parseLogLevel(env.LOG_LEVEL ?? (production ? "info" : "debug"))),
    background,
  ),
);

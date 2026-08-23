import { isSpanContextValid, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecord } from "@opentelemetry/api-logs";
import { Layer, Logger, ManagedRuntime, pipe, References } from "effect";
import type { LogLevel } from "effect/LogLevel";
import { createBotEnv } from "@starlight/utils/env";
import * as Model from "@/ai/model";
import * as Conversation from "@/conversation/conversation";
import * as TelegramDelivery from "@/conversation/delivery";
import * as WakeOutbox from "@/conversation/wake-outbox";
import * as WakeQueue from "@/conversation/wake-queue";
import * as ConversationContext from "@/context/context";
import * as Database from "@/services/database";
import * as Exa from "@/services/exa";

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
		const message = Array.isArray(output.message)
			? output.message.join(" ")
			: String(output.message);
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
	return spanContext && isSpanContextValid(spanContext)
		? trace.setSpanContext(ROOT_CONTEXT, spanContext)
		: undefined;
}

const production = env.NODE_ENV === "production";

const infrastructure = Layer.mergeAll(
	Database.layer(env.DATABASE_URL),
	Exa.defaultLayer,
	Model.defaultLayer,
	TelegramDelivery.layer(env.STARLIGHT_BOT_TOKEN),
	WakeQueue.layer(env.REDIS_URL, env.CONVERSATION_QUEUE_PREFIX),
	Conversation.optionsLayer({
		affinitySecret: env.CONVERSATION_AFFINITY_SECRET,
		leaseMs: env.CONVERSATION_LANE_LEASE_MS,
		maxWaitMs: env.CONVERSATION_BATCH_MAX_WAIT_MS,
		quietMs: env.CONVERSATION_BATCH_QUIET_MS,
	}),
);
const domain = Layer.mergeAll(Conversation.layer, ConversationContext.layer, WakeOutbox.layer).pipe(
	Layer.provideMerge(infrastructure),
);
const background = Layer.mergeAll(
	WakeOutbox.publisherLayer,
	WakeQueue.workerLayer(env.REDIS_URL, env.CONVERSATION_QUEUE_PREFIX),
).pipe(Layer.provideMerge(domain));

export const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		Logger.layer([
			production ? Logger.consoleJson : Logger.consolePretty(),
			...(env.otlp === undefined ? [] : [otelSink()]),
			Logger.tracerLogger,
		]),
		Layer.succeed(References.MinimumLogLevel)(
			parseLogLevel(env.LOG_LEVEL ?? (production ? "info" : "debug")),
		),
		background,
	),
);

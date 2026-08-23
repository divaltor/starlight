import { isSpanContextValid, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecord } from "@opentelemetry/api-logs";
import { Layer, Logger, ManagedRuntime, pipe, References } from "effect";
import type { LogLevel } from "effect/LogLevel";
import { createBotEnv } from "@starlight/utils/env";
import * as Model from "@/ai/model";
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

function parseLogLevel(name: string): LogLevel {
	switch (name.toLowerCase()) {
		case "trace": {
			return "Trace";
		}
		case "debug": {
			return "Debug";
		}
		case "warn": {
			return "Warn";
		}
		case "error": {
			return "Error";
		}
		case "fatal": {
			return "Fatal";
		}
		default: {
			return "Info";
		}
	}
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
		Exa.defaultLayer,
		Model.defaultLayer,
	),
);

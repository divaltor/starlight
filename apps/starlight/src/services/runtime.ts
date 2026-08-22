import env from "@starlight/utils/config";
import { Layer, Logger, ManagedRuntime, pipe, References } from "effect";
import type { LogLevel } from "effect/LogLevel";
import { logger } from "@/logger";
import * as Exa from "@/services/exa";

type StructuredLogOutput = ReturnType<(typeof Logger.formatStructured)["log"]>;

function forwardEffectLog(output: StructuredLogOutput): void {
	const text = Array.isArray(output.message) ? output.message.join(" ") : String(output.message);
	const metadata = {
		annotations: output.annotations,
		cause: output.cause,
		fiberId: output.fiberId,
		spans: output.spans,
	};

	switch (output.level) {
		case "FATAL":
		case "ERROR": {
			logger.error(metadata, text);
			break;
		}
		case "WARN": {
			logger.warn(metadata, text);
			break;
		}
		case "DEBUG": {
			logger.debug(metadata, text);
			break;
		}
		case "TRACE": {
			logger.trace(metadata, text);
			break;
		}
		default: {
			logger.info(metadata, text);
		}
	}
}

const effectLogger = pipe(Logger.formatStructured, Logger.map(forwardEffectLog));

const getEffectLogLevel = (): LogLevel => {
	switch ((env.LOG_LEVEL || (env.NODE_ENV === "development" ? "debug" : "info")).toLowerCase()) {
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
};

const loggingLayer = Layer.mergeAll(
	Logger.layer([effectLogger, Logger.tracerLogger]),
	Layer.succeed(References.MinimumLogLevel)(getEffectLogLevel()),
);

export const runtime = ManagedRuntime.make(Layer.mergeAll(loggingLayer, Exa.defaultLayer));

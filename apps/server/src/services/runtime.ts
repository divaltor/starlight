import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { Layer, Logger, ManagedRuntime, pipe, References } from "effect";
import type { LogLevel } from "effect/LogLevel";
import env from "@/env";
import { logger } from "@/logger";
import { TwitterApi } from "@/services/twitter-api";

// Derived from Logger.formatStructured's output; effect does not export this structural type.
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

// pipe form: Logger.map(self, fn) reads as Array#map(callback, thisArg) to oxlint
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

const effectLogLevel = getEffectLogLevel();

const loggingLayer = Layer.mergeAll(
  Logger.layer([effectLogger, Logger.tracerLogger]),
  Layer.succeed(References.MinimumLogLevel)(effectLogLevel),
);

export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    loggingLayer,
    TwitterApi.defaultLayer,
    EmbeddingsService.defaultLayer({ apiToken: env.ML_API_TOKEN, baseUrl: env.ML_BASE_URL }),
  ),
);

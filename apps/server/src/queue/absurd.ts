import type { RetryStrategy } from "absurd-sdk";
import { logger } from "@/logger";

type AbsurdLogLevel = "debug" | "error" | "info" | "warn";

function writeAbsurdLog(level: AbsurdLogLevel, args: unknown[]) {
	const [message, ...values] = args;
	const err = values.find((value) => value instanceof Error);
	const details = values.filter((value) => value !== err);
	const fields = {
		...(err ? { err } : {}),
		...(details.length > 0 ? { details } : {}),
		...(typeof message === "string" ? {} : { value: message }),
	};
	const text = typeof message === "string" ? message : "[absurd] log event";

	switch (level) {
		case "debug":
			logger.debug(fields, text);
			break;
		case "info":
			logger.info(fields, text);
			break;
		case "warn":
			logger.warn(fields, text);
			break;
		case "error":
			logger.error(fields, text);
			break;
	}
}

export const absurdLogger = {
	log: (...args: unknown[]) => writeAbsurdLog("debug", args),
	info: (...args: unknown[]) => writeAbsurdLog("info", args),
	warn: (...args: unknown[]) => writeAbsurdLog("warn", args),
	error: (...args: unknown[]) => writeAbsurdLog("error", args),
};

export const QUEUES = {
	classification: "classification",
	embeddings: "embeddings",
	// Persisted queue/task name; keep stable for jobs created before the provider-neutral rename.
	media: "images-collector",
	memory: "chat-memory",
	pixiv: "pixiv-bookmarks",
	scrapper: "feed-scrapper",
} as const;

export const RETRY = {
	classification: { kind: "exponential", baseSeconds: 30, factor: 2 } satisfies RetryStrategy,
	embeddings: { kind: "exponential", baseSeconds: 30, factor: 2 } satisfies RetryStrategy,
	media: { kind: "exponential", baseSeconds: 10, factor: 2 } satisfies RetryStrategy,
	memory: { kind: "exponential", baseSeconds: 20, factor: 2 } satisfies RetryStrategy,
	pixiv: { kind: "exponential", baseSeconds: 150, factor: 2 } satisfies RetryStrategy,
	scrapper: { kind: "exponential", baseSeconds: 150, factor: 2 } satisfies RetryStrategy,
} as const;

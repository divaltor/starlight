import type { RetryStrategy } from "absurd-sdk";

export const QUEUES = {
	classification: "classification",
	embeddings: "embeddings",
	images: "images-collector",
	memory: "chat-memory",
	scrapper: "feed-scrapper",
} as const;

export const RETRY = {
	classification: { kind: "exponential", baseSeconds: 30, factor: 2 } satisfies RetryStrategy,
	embeddings: { kind: "exponential", baseSeconds: 30, factor: 2 } satisfies RetryStrategy,
	images: { kind: "exponential", baseSeconds: 10, factor: 2 } satisfies RetryStrategy,
	memory: { kind: "exponential", baseSeconds: 20, factor: 2 } satisfies RetryStrategy,
	scrapper: { kind: "exponential", baseSeconds: 150, factor: 2 } satisfies RetryStrategy,
} as const;

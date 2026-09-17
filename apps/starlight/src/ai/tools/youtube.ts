import { tool } from "ai";
import type { Tool } from "ai";
import { BunRedis } from "@effect/platform-bun";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import type { CacheStrategy, TranscriptResult } from "youtube-transcript-plus";
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptInvalidVideoIdError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript-plus";
import { z } from "zod";

export namespace Youtube {
  export const profileId = "youtube-transcript-v1";
  const FETCH_TIMEOUT_MS = 20_000;
  const MAX_TEXT_CHARS = 12_000;
  const FETCH_RETRIES = 2;
  const FETCH_RETRY_DELAY_MS = 1000;
  // Transcripts are immutable; share them for a month so repeat questions
  // never cost extra YouTube requests from our rate-limited IP.
  const CACHE_TTL_MS = 30 * 24 * 3_600_000;
  const youtubeUrl = z
    .url()
    .regex(
      /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}(?:[?#&/].*)?$/iu,
      "Expected a YouTube video URL",
    );
  const bcp47 = z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/u, "Expected a BCP 47 language code");

  export class YoutubeError extends Schema.TaggedError<YoutubeError>()("YoutubeError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    static fromCause(input: { message: string; cause: unknown }) {
      return new YoutubeError(input);
    }
  }

  export interface Transcript {
    readonly author: string;
    readonly durationSeconds: number;
    readonly language: string;
    readonly text: string;
    readonly title: string;
    readonly totalChars: number;
    readonly truncated: boolean;
    readonly videoId: string;
  }

  export interface Interface {
    readonly tools: { readonly read_youtube: Tool<{ lang?: string; url: string }> };
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Youtube") {}

  export type Fetcher = (
    videoId: string,
    config: { readonly lang?: string; readonly signal?: AbortSignal },
  ) => Promise<TranscriptResult>;

  // Minimal Redis surface so tests can substitute a fake without a server.
  export interface RedisCommands {
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string, ex: "EX", seconds: number) => Promise<"OK">;
  }

  // Shared-cache adapter: a Redis outage degrades to a cache miss, never a tool failure.
  export class RedisCache implements CacheStrategy {
    private readonly client: RedisCommands;
    private readonly defaultTTL: number;

    constructor(client: RedisCommands, defaultTTL = CACHE_TTL_MS) {
      this.client = client;
      this.defaultTTL = defaultTTL;
    }

    async get(key: string): Promise<string | null> {
      try {
        return await this.client.get(`youtube:${key}`);
      } catch {
        return null;
      }
    }

    async set(key: string, value: string, ttl?: number): Promise<void> {
      const seconds = Math.max(1, Math.ceil((ttl ?? this.defaultTTL) / 1000));
      try {
        await this.client.set(`youtube:${key}`, value, "EX", seconds);
      } catch {
        // Write failures degrade to a miss on the next read.
      }
    }
  }

  export function layerWithFetcher(fetcher: Fetcher): Layer.Layer<Service> {
    return Layer.succeed(Service, makeService(fetcher));
  }

  export function layer(redisUrl: string): Layer.Layer<Service> {
    const redisBacked: Layer.Layer<Service, never, BunRedis.BunRedis> = Layer.effect(
      Service,
      Effect.gen(function* make() {
        const redis = yield* BunRedis.BunRedis;
        const commands: RedisCommands = {
          get: (key) => redis.client.get(key),
          set: (key, value, ex, seconds) => redis.client.set(key, value, ex, seconds),
        };
        return makeService(makeFetcher(new RedisCache(commands)));
      }),
    );
    return redisBacked.pipe(Layer.provide(BunRedis.layer({ url: redisUrl })));
  }

  function makeFetcher(cache: CacheStrategy): Fetcher {
    return (videoId, config) =>
      fetchTranscript(videoId, {
        cache,
        cacheTTL: CACHE_TTL_MS,
        lang: config.lang,
        retries: FETCH_RETRIES,
        retryDelay: FETCH_RETRY_DELAY_MS,
        signal: config.signal,
        videoDetails: true,
      });
  }

  function makeService(fetcher: Fetcher): Interface {
    const readTranscript = Effect.fn("Youtube.readTranscript")(function* readTranscript(
      url: string,
      lang: string | undefined,
      signal: AbortSignal | undefined,
    ) {
      const result = yield* Effect.tryPromise({
        try: () => fetcher(url, { lang, signal }),
        catch: (cause) => mapFetchError(cause),
      }).pipe(
        Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
        Effect.mapError((cause) =>
          cause instanceof YoutubeError
            ? cause
            : YoutubeError.fromCause({ cause, message: "Timed out fetching the YouTube transcript" }),
        ),
      );
      if (result.segments.length === 0) {
        return yield* new YoutubeError({ message: "No transcript is available for this YouTube video" });
      }
      const full = result.segments.map((segment) => `[${formatTimestamp(segment.offset)}] ${segment.text}`).join("\n");
      const truncated = full.length > MAX_TEXT_CHARS;
      const transcript: Transcript = {
        author: result.videoDetails.author,
        durationSeconds: result.videoDetails.lengthSeconds,
        language: result.segments[0]?.lang ?? lang ?? "unknown",
        text: truncated ? [...full].slice(0, MAX_TEXT_CHARS).join("") : full,
        title: result.videoDetails.title,
        totalChars: full.length,
        truncated,
        videoId: result.videoDetails.videoId,
      };
      return transcript;
    });

    return {
      tools: {
        read_youtube: tool({
          description:
            "Fetch the transcript (captions) of a public YouTube video with its title and author. Use this instead of web_fetch_exa for YouTube watch, shorts, embed, live, or youtu.be URLs when asked what a video contains or to summarize it. Returns timestamped transcript lines, not a summary; summarize from them yourself. Optional lang is a BCP 47 code such as 'en'; omit it for the default track. truncated:true means the tail was cut. Fails when captions are missing, disabled, or YouTube rate-limits this server.",
          inputSchema: z.object({ lang: bcp47.optional(), url: youtubeUrl }),
          execute: (input, options) =>
            Effect.runPromise(readTranscript(input.url, input.lang, options.abortSignal), {
              signal: options.abortSignal,
            }),
        }),
      },
    };
  }

  function mapFetchError(cause: unknown): YoutubeError {
    if (cause instanceof YoutubeTranscriptTooManyRequestError) {
      return new YoutubeError({
        message: "YouTube is rate-limiting transcript requests from this server. Try again later",
      });
    }
    if (cause instanceof YoutubeTranscriptVideoUnavailableError) {
      return new YoutubeError({ message: "This YouTube video is unavailable or has been removed" });
    }
    if (cause instanceof YoutubeTranscriptDisabledError) {
      return new YoutubeError({ message: "Transcripts are disabled for this YouTube video" });
    }
    if (cause instanceof YoutubeTranscriptNotAvailableError) {
      return new YoutubeError({ message: "No transcript is available for this YouTube video" });
    }
    if (cause instanceof YoutubeTranscriptNotAvailableLanguageError) {
      return new YoutubeError({
        message: `No ${cause.lang} transcript for this video. Available languages: ${cause.availableLangs.join(", ") || "none"}`,
      });
    }
    if (cause instanceof YoutubeTranscriptInvalidVideoIdError) {
      return new YoutubeError({ message: "Expected a YouTube video URL" });
    }
    return YoutubeError.fromCause({ cause, message: "Failed to fetch the YouTube transcript" });
  }

  function formatTimestamp(offset: number): string {
    const total = Math.max(0, Math.floor(offset));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const minutePart = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
    const hourPart = hours > 0 ? `${hours}:` : "";
    return `${hourPart}${minutePart}:${String(seconds).padStart(2, "0")}`;
  }
}

import type { FileApiFlavor } from "@grammyjs/files";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Api } from "grammy";
import type { Message } from "grammy/types";

export namespace Media {
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 40_000_000;
  const REQUEST_TIMEOUT_MS = 30_000;
  const DOWNLOAD_FAILED = "Failed to download Telegram media";
  const SOURCE_TOO_LARGE = "Telegram media exceeds the 20 MiB download boundary";
  const JPEG_QUALITIES = [85, 70, 55, 40] as const;

  export const Type = Schema.Literals([
    "animation",
    "audio",
    "document",
    "photo",
    "sticker",
    "video",
    "video-note",
    "voice",
  ]);
  export type Type = typeof Type.Type;

  const StoredReferenceSchema = Schema.Struct({
    availability: Schema.Literal("stored"),
    mimeType: Schema.String,
    s3Key: Schema.String,
    sha256: Schema.String,
    size: Schema.Int,
    stableDescription: Schema.String,
    telegramFileId: Schema.String,
    telegramFileUniqueId: Schema.String,
    type: Type,
  });
  const UnavailableReferenceSchema = Schema.Struct({
    availability: Schema.Literal("unavailable"),
    mimeType: Schema.String,
    reason: Schema.String,
    stableDescription: Schema.String,
    telegramFileId: Schema.String,
    telegramFileUniqueId: Schema.String,
    type: Type,
  });
  export const ReferenceSchema = Schema.Union([StoredReferenceSchema, UnavailableReferenceSchema]);
  export type Reference = typeof ReferenceSchema.Type;

  export interface Source {
    readonly declaredSize: number | null;
    readonly mimeType: string;
    readonly telegramFileId: string;
    readonly telegramFileUniqueId: string;
    readonly type: Type;
  }

  export interface Loaded {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly sha256: string;
    readonly type: Type;
  }

  export class MediaError extends Schema.TaggedError<MediaError>()("MediaError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export interface Options {
    readonly accessKeyId: string;
    readonly endpoint?: string;
    readonly secretAccessKey: string;
    readonly telegramApi: FileApiFlavor<Api>;
  }

  export interface Interface {
    readonly ingest: (source: Source) => Effect.Effect<Reference, MediaError>;
    readonly load: (reference: Reference) => Effect.Effect<Loaded | null, MediaError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Media") {}

  export function fromTelegramMessage(message: Message | undefined): Source[] {
    if (!message) return [];
    if (message.photo?.length) {
      const photo = message.photo.at(-1)!;
      return [createSource("photo", photo.file_id, photo.file_unique_id, "image/jpeg", photo.file_size)];
    }
    if (message.sticker) {
      const file =
        message.sticker.is_animated || message.sticker.is_video ? message.sticker.thumbnail : message.sticker;
      return file ? [createSource("sticker", file.file_id, file.file_unique_id, "image/webp", file.file_size)] : [];
    }
    if (message.animation) {
      return [
        createSource(
          "animation",
          message.animation.file_id,
          message.animation.file_unique_id,
          message.animation.mime_type ?? "video/mp4",
          message.animation.file_size,
        ),
      ];
    }
    if (message.video) {
      return [
        createSource(
          "video",
          message.video.file_id,
          message.video.file_unique_id,
          message.video.mime_type ?? "video/mp4",
          message.video.file_size,
        ),
      ];
    }
    if (message.video_note) {
      return [
        createSource(
          "video-note",
          message.video_note.file_id,
          message.video_note.file_unique_id,
          "video/mp4",
          message.video_note.file_size,
        ),
      ];
    }
    if (message.voice) {
      return [
        createSource(
          "voice",
          message.voice.file_id,
          message.voice.file_unique_id,
          message.voice.mime_type ?? "audio/ogg",
          message.voice.file_size,
        ),
      ];
    }
    if (message.audio) {
      return [
        createSource(
          "audio",
          message.audio.file_id,
          message.audio.file_unique_id,
          message.audio.mime_type ?? "audio/mpeg",
          message.audio.file_size,
        ),
      ];
    }
    if (message.document) {
      return [
        createSource(
          "document",
          message.document.file_id,
          message.document.file_unique_id,
          message.document.mime_type ?? "application/octet-stream",
          message.document.file_size,
        ),
      ];
    }
    return [];
  }

  export function layer(options: Options): Layer.Layer<Service, never, HttpClient.HttpClient> {
    return Layer.effect(
      Service,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return Service.of(make(options, client));
      }),
    );
  }

  function make(options: Options, client: HttpClient.HttpClient): Interface {
    const s3 = new Bun.S3Client({
      accessKeyId: options.accessKeyId,
      endpoint: options.endpoint,
      secretAccessKey: options.secretAccessKey,
    });

    const download = Effect.fn("Media.download")(function* download(source: Source | Reference) {
      yield* Effect.annotateCurrentSpan({ "media.mime_type": source.mimeType, "media.type": source.type });
      const file = yield* Effect.tryPromise({
        try: () => options.telegramApi.getFile(source.telegramFileId, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
        catch: (cause) => new MediaError({ cause, message: DOWNLOAD_FAILED, retryable: true }),
      });
      const response = yield* client.execute(HttpClientRequest.get(file.getUrl())).pipe(
        Effect.timeout(Duration.millis(REQUEST_TIMEOUT_MS)),
        Effect.mapError((cause) => new MediaError({ cause, message: DOWNLOAD_FAILED, retryable: true })),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new MediaError({
          message: `Telegram file download returned ${response.status}`,
          retryable: true,
        });
      }
      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
        return yield* new MediaError({
          message: SOURCE_TOO_LARGE,
          retryable: true,
        });
      }
      const bytes = new Uint8Array(
        yield* response.arrayBuffer.pipe(
          Effect.mapError((cause) => new MediaError({ cause, message: DOWNLOAD_FAILED, retryable: true })),
        ),
      );
      if (bytes.byteLength > MAX_SOURCE_BYTES) {
        return yield* new MediaError({
          message: SOURCE_TOO_LARGE,
          retryable: true,
        });
      }
      return bytes;
    });

    const ingest = Effect.fn("Media.ingest")(function* ingest(source: Source) {
      if (source.declaredSize !== null && source.declaredSize > MAX_SOURCE_BYTES) {
        return unavailable(source, "media exceeds the 20 MiB boundary");
      }
      if (source.mimeType === "application/pdf") return unavailable(source, "PDF processing pipeline is planned");
      if (!isSupported(source)) return unavailable(source, "media type is not supported by the model pipeline");

      const downloaded = yield* download(source);
      const bytes = isNormalizableImage(source) ? yield* normalizeImage(downloaded) : downloaded;
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const s3Key = `telegram-media/${sha256}`;
      yield* Effect.tryPromise({
        try: async () => {
          if (!(await s3.exists(s3Key))) await s3.write(s3Key, bytes, { type: normalizedMimeType(source) });
        },
        catch: (cause) => new MediaError({ cause, message: "Failed to persist media in S3", retryable: true }),
      }).pipe(
        Effect.withSpan("Media persist", {
          attributes: {
            "media.mime_type": normalizedMimeType(source),
            "media.size_bytes": bytes.byteLength,
            "media.type": source.type,
          },
        }),
      );
      return {
        availability: "stored" as const,
        mimeType: normalizedMimeType(source),
        s3Key,
        sha256,
        size: bytes.byteLength,
        stableDescription: `${source.type} (${normalizedMimeType(source)}, ${bytes.byteLength} bytes, sha256:${sha256})`,
        telegramFileId: source.telegramFileId,
        telegramFileUniqueId: source.telegramFileUniqueId,
        type: source.type,
      };
    });

    const load = Effect.fn("Media.load")(function* load(reference: Reference) {
      if (reference.availability === "unavailable") return null;
      const stored = yield* Effect.tryPromise({
        try: async () =>
          (await s3.exists(reference.s3Key)) ? new Uint8Array(await s3.file(reference.s3Key).arrayBuffer()) : null,
        catch: (cause) => new MediaError({ cause, message: "Failed to load media from S3", retryable: true }),
      }).pipe(
        Effect.withSpan("Media load stored", {
          attributes: {
            "media.mime_type": reference.mimeType,
            "media.size_bytes": reference.size,
            "media.type": reference.type,
          },
        }),
      );
      const downloaded = stored ?? (yield* download(reference));
      const bytes =
        stored === null && reference.mimeType.startsWith("image/") && reference.mimeType !== "image/gif"
          ? yield* normalizeImage(downloaded)
          : downloaded;
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      if (sha256 !== reference.sha256) {
        return yield* new MediaError({
          message: "Loaded media digest does not match its frozen reference",
          retryable: false,
        });
      }
      if (stored === null) {
        yield* Effect.tryPromise({
          try: () => s3.write(reference.s3Key, bytes, { type: reference.mimeType }),
          catch: (cause) => new MediaError({ cause, message: "Failed to repair media in S3", retryable: true }),
        }).pipe(
          Effect.withSpan("Media repair stored", {
            attributes: {
              "media.mime_type": reference.mimeType,
              "media.size_bytes": bytes.byteLength,
              "media.type": reference.type,
            },
          }),
        );
      }
      return { bytes, mimeType: reference.mimeType, sha256, type: reference.type };
    });

    return { ingest, load };
  }

  function normalizeImage(bytes: Uint8Array): Effect.Effect<Uint8Array, MediaError> {
    return Effect.tryPromise({
      try: async () => {
        for (const quality of JPEG_QUALITIES) {
          const normalized = await new Bun.Image(bytes, { maxPixels: MAX_IMAGE_PIXELS })
            .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality })
            .bytes();
          if (normalized.byteLength <= MAX_IMAGE_BYTES) return normalized;
        }
        throw new Error("Normalized image exceeds the 5 MiB model boundary");
      },
      catch: (cause) => new MediaError({ cause, message: "Failed to normalize image", retryable: false }),
    }).pipe(Effect.withSpan("Media normalize image", { attributes: { "media.source_size_bytes": bytes.byteLength } }));
  }

  function unavailable(source: Source, reason: string): Reference {
    return {
      availability: "unavailable",
      mimeType: source.mimeType,
      reason,
      stableDescription: `${source.type} unavailable: ${reason}`,
      telegramFileId: source.telegramFileId,
      telegramFileUniqueId: source.telegramFileUniqueId,
      type: source.type,
    };
  }

  function isNormalizableImage(source: Source): boolean {
    return source.mimeType.startsWith("image/") && source.mimeType !== "image/gif";
  }

  function normalizedMimeType(source: Source): string {
    return isNormalizableImage(source) ? "image/jpeg" : source.mimeType;
  }

  function isSupported(source: Source): boolean {
    return (
      source.mimeType.startsWith("image/") ||
      source.mimeType.startsWith("text/") ||
      source.mimeType.startsWith("video/") ||
      source.mimeType.startsWith("audio/")
    );
  }

  function createSource(
    type: Type,
    telegramFileId: string,
    telegramFileUniqueId: string,
    mimeType: string,
    declaredSize: number | undefined,
  ): Source {
    return { declaredSize: declaredSize ?? null, mimeType, telegramFileId, telegramFileUniqueId, type };
  }
}

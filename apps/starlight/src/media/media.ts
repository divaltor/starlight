import { Context, Effect, Layer, Schema } from "effect";

export namespace Media {
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 40_000_000;
  const REQUEST_TIMEOUT_MS = 30_000;
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
    readonly telegramToken: string;
  }

  export interface Interface {
    readonly ingest: (source: Source) => Effect.Effect<Reference, MediaError>;
    readonly load: (reference: Reference) => Effect.Effect<Loaded | null, MediaError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Media") {}

  export function layer(options: Options): Layer.Layer<Service> {
    return Layer.succeed(Service, Service.of(make(options)));
  }

  function make(options: Options): Interface {
    const s3 = new Bun.S3Client({
      accessKeyId: options.accessKeyId,
      endpoint: options.endpoint,
      secretAccessKey: options.secretAccessKey,
    });

    const download = Effect.fn("Media.download")(function* download(fileId: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          const metadataResponse = await fetch(
            `https://api.telegram.org/bot${options.telegramToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          );
          if (!metadataResponse.ok) throw new Error(`Telegram getFile returned ${metadataResponse.status}`);
          const metadata = Schema.decodeUnknownSync(
            Schema.Struct({ ok: Schema.Literal(true), result: Schema.Struct({ file_path: Schema.String }) }),
          )(await metadataResponse.json());
          const response = await fetch(
            `https://api.telegram.org/file/bot${options.telegramToken}/${metadata.result.file_path}`,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          );
          if (!response.ok) throw new Error(`Telegram file download returned ${response.status}`);
          const contentLength = Number(response.headers.get("content-length"));
          if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
            throw new Error("Telegram media exceeds the 20 MiB download boundary");
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > MAX_SOURCE_BYTES)
            throw new Error("Telegram media exceeds the 20 MiB download boundary");
          return bytes;
        },
        catch: (cause) => new MediaError({ cause, message: "Failed to download Telegram media", retryable: true }),
      });
    });

    const ingest = Effect.fn("Media.ingest")(function* ingest(source: Source) {
      if (source.declaredSize !== null && source.declaredSize > MAX_SOURCE_BYTES) {
        return unavailable(source, "media exceeds the 20 MiB boundary");
      }
      if (source.mimeType === "application/pdf") return unavailable(source, "PDF processing pipeline is planned");
      if (!isSupported(source)) return unavailable(source, "media type is not supported by the model pipeline");

      const downloaded = yield* download(source.telegramFileId);
      const bytes = isNormalizableImage(source) ? yield* normalizeImage(downloaded) : downloaded;
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const s3Key = `telegram-media/${sha256}`;
      yield* Effect.tryPromise({
        try: async () => {
          if (!(await s3.exists(s3Key))) await s3.write(s3Key, bytes, { type: normalizedMimeType(source) });
        },
        catch: (cause) => new MediaError({ cause, message: "Failed to persist media in S3", retryable: true }),
      });
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
      });
      const downloaded = stored ?? (yield* download(reference.telegramFileId));
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
        });
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
    });
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
}

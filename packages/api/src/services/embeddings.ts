import env from "@starlight/utils/config";
import { context, propagation } from "@opentelemetry/api";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export namespace EmbeddingsService {
  // Without a deadline a stalled ML service pins the caller forever: the
  // concurrency-1 embeddings worker slot (BullMQ renews the lock, so the job
  // never fails) or a runner update context.
  const EMBEDDINGS_TIMEOUT_MS = 30_000;
  const QUERY_EMBEDDINGS_TIMEOUT_MS = 10_000;

  export class EmbeddingsError extends Schema.TaggedError<EmbeddingsError>()("EmbeddingsError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    static fromCause(input: { message: string; cause: unknown }) {
      return new EmbeddingsError({
        message: input.message,
        cause: input.cause,
      });
    }
  }

  const EmbeddingsResponse = Schema.Struct({
    image: Schema.NullOr(Schema.Array(Schema.Number)),
    text: Schema.Array(Schema.Number),
  });

  const TextEmbeddingsResponse = Schema.Struct({
    text: Schema.Array(Schema.Number),
  });

  export interface Interface {
    readonly isEnabled: () => boolean;
    readonly generate: (
      image: string,
      tags: string[],
      requestId?: string,
    ) => Effect.Effect<{ readonly image: number[] | null; readonly text: number[] } | null, EmbeddingsError>;
    readonly generateText: (query: string, requestId?: string) => Effect.Effect<number[] | null, EmbeddingsError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/EmbeddingsService") {}

  export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const client = yield* HttpClient.HttpClient;

      const generate = Effect.fn("EmbeddingsService.generate")(function* generate(
        image: string,
        tags: string[],
        requestId?: string,
      ) {
        yield* Effect.logInfo(`EmbeddingsService: Generating embeddings for ${image}`);

        const headers = {
          "X-API-Token": env.ML_API_TOKEN!,
          "X-Request-Id": requestId ?? Bun.randomUUIDv7(),
        };
        propagation.inject(context.active(), headers);

        const request = yield* HttpClientRequest.post(`${env.ML_BASE_URL}/v1/embeddings`).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJson({
            image,
            tags,
          }),
          Effect.mapError((error) =>
            EmbeddingsError.fromCause({
              message: "Failed to encode request body",
              cause: error,
            }),
          ),
        );

        const response = yield* client.execute(request).pipe(
          Effect.timeout(Duration.millis(EMBEDDINGS_TIMEOUT_MS)),
          Effect.mapError((error) => EmbeddingsError.fromCause({ message: "API request failed", cause: error })),
        );

        const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.catch(() =>
            Effect.logInfo(`EmbeddingsService: API request failed for ${image}, status ${response.status}`).pipe(
              Effect.as(null),
            ),
          ),
        );

        if (!okResponse) {
          return null;
        }

        const data = yield* HttpClientResponse.schemaBodyJson(EmbeddingsResponse)(okResponse).pipe(
          Effect.mapError((error) =>
            EmbeddingsError.fromCause({
              message: "Failed to parse API response",
              cause: error,
            }),
          ),
        );

        yield* Effect.logInfo(`EmbeddingsService: Successfully generated embeddings for ${image}`);
        return {
          image: data.image ? [...data.image] : null,
          text: [...data.text],
        };
      });

      const generateText = Effect.fn("EmbeddingsService.generateText")(function* generateText(
        query: string,
        requestId?: string,
      ) {
        yield* Effect.logInfo("EmbeddingsService: Generating text embeddings");

        const headers = {
          "X-API-Token": env.ML_API_TOKEN!,
          "X-Request-Id": requestId ?? Bun.randomUUIDv7(),
        };
        propagation.inject(context.active(), headers);

        const request = yield* HttpClientRequest.post(`${env.ML_BASE_URL}/v1/embeddings`).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJson({
            tags: query,
            encoding_mode: "retrieval.query",
          }),
          Effect.mapError((error) =>
            EmbeddingsError.fromCause({
              message: "Failed to encode request body",
              cause: error,
            }),
          ),
        );

        const response = yield* client.execute(request).pipe(
          Effect.timeout(Duration.millis(QUERY_EMBEDDINGS_TIMEOUT_MS)),
          Effect.mapError((error) => EmbeddingsError.fromCause({ message: "API request failed", cause: error })),
        );

        const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.catch(() =>
            Effect.logInfo(`EmbeddingsService: API request failed, status ${response.status}`).pipe(Effect.as(null)),
          ),
        );

        if (!okResponse) {
          return null;
        }

        const data = yield* HttpClientResponse.schemaBodyJson(TextEmbeddingsResponse)(okResponse).pipe(
          Effect.mapError((error) =>
            EmbeddingsError.fromCause({
              message: "Failed to parse API response",
              cause: error,
            }),
          ),
        );

        yield* Effect.logInfo("EmbeddingsService: Successfully generated text embeddings");
        return [...data.text];
      });

      return Service.of({
        isEnabled: () => !!(env.ML_BASE_URL && env.ML_API_TOKEN),
        generate,
        generateText,
      });
    }),
  );

  export const defaultLayer: Layer.Layer<Service> = layer.pipe(Layer.provide(FetchHttpClient.layer));
}

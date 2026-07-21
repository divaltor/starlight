import env from "@starlight/utils/config";
import { Context, Effect, Layer, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";

export class EmbeddingsError extends Schema.TaggedErrorClass<EmbeddingsError>()("EmbeddingsError", {
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

export namespace EmbeddingsService {
	export interface Interface {
		readonly isEnabled: () => boolean;
		readonly generate: (
			image: string,
			tags: string[],
			requestId?: string,
		) => Effect.Effect<
			{ readonly image: number[] | null; readonly text: number[] } | null,
			EmbeddingsError
		>;
		readonly generateText: (
			query: string,
			requestId?: string,
		) => Effect.Effect<number[] | null, EmbeddingsError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		"starlight/EmbeddingsService",
	) {}

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const generate = Effect.fn("EmbeddingsService.generate")(function* (
				image: string,
				tags: string[],
				requestId?: string,
			) {
				yield* Effect.logInfo(`EmbeddingsService: Generating embeddings for ${image}`);

				const request = yield* HttpClientRequest.post(`${env.ML_BASE_URL}/v1/embeddings`).pipe(
					HttpClientRequest.setHeaders({
						"X-API-Token": env.ML_API_TOKEN!,
						"X-Request-Id": requestId ?? Bun.randomUUIDv7(),
					}),
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

				const response = yield* client
					.execute(request)
					.pipe(
						Effect.mapError((error) =>
							EmbeddingsError.fromCause({ message: "API request failed", cause: error }),
						),
					);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logInfo(
							`EmbeddingsService: API request failed for ${image}, status ${response.status}`,
						).pipe(Effect.as(null)),
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
					image: data.image ? Array.from(data.image) : null,
					text: Array.from(data.text),
				};
			});

			const generateText = Effect.fn("EmbeddingsService.generateText")(function* (
				query: string,
				requestId?: string,
			) {
				yield* Effect.logInfo("EmbeddingsService: Generating text embeddings");

				const request = yield* HttpClientRequest.post(`${env.ML_BASE_URL}/v1/embeddings`).pipe(
					HttpClientRequest.setHeaders({
						"X-API-Token": env.ML_API_TOKEN!,
						"X-Request-Id": requestId ?? Bun.randomUUIDv7(),
					}),
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

				const response = yield* client
					.execute(request)
					.pipe(
						Effect.mapError((error) =>
							EmbeddingsError.fromCause({ message: "API request failed", cause: error }),
						),
					);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logInfo(`EmbeddingsService: API request failed, status ${response.status}`).pipe(
							Effect.as(null),
						),
					),
				);

				if (!okResponse) {
					return null;
				}

				const data = yield* HttpClientResponse.schemaBodyJson(TextEmbeddingsResponse)(
					okResponse,
				).pipe(
					Effect.mapError((error) =>
						EmbeddingsError.fromCause({
							message: "Failed to parse API response",
							cause: error,
						}),
					),
				);

				yield* Effect.logInfo("EmbeddingsService: Successfully generated text embeddings");
				return Array.from(data.text);
			});

			return Service.of({
				isEnabled: () => !!(env.ML_BASE_URL && env.ML_API_TOKEN),
				generate,
				generateText,
			});
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}

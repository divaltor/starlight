import env from "@starlight/utils/config";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import { ExtractionError, type ExtractionResult } from "@/services/extractors/base";

const EXA_TIMEOUT_MS = 10_000;

const ExaContentsResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			text: Schema.optional(Schema.String),
		}),
	),
	statuses: Schema.optional(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				status: Schema.String,
				error: Schema.optional(
					Schema.Struct({
						tag: Schema.String,
						httpStatusCode: Schema.optional(Schema.NullOr(Schema.Number)),
					}),
				),
			}),
		),
	),
});

export namespace ExaExtractor {
	export interface Interface {
		readonly isEnabled: () => boolean;
		readonly extract: (url: string) => Effect.Effect<ExtractionResult | null, ExtractionError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		"starlight/extractors/ExaExtractor",
	) {}

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const extract = Effect.fn("ExaExtractor.extract")(function* (url: string) {
				yield* Effect.logInfo(`ExaExtractor: Starting extraction for ${url}`);

				const request = yield* HttpClientRequest.post(`${env.EXA_API_BASE_URL}/contents`).pipe(
					HttpClientRequest.setHeaders({
						"x-api-key": env.EXA_API_KEY!,
					}),
					HttpClientRequest.bodyJson({
						ids: [url],
						text: true,
						livecrawlTimeout: 10_000,
					}),
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ExaExtractor",
							message: "Failed to encode request body",
							cause: error,
						}),
					),
				);

				const response = yield* client.execute(request).pipe(
					Effect.timeout(Duration.millis(EXA_TIMEOUT_MS)),
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ExaExtractor",
							message: "API request failed",
							cause: error,
						}),
					),
				);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logInfo(
							`ExaExtractor: API request failed for ${url}, status ${response.status}`,
						).pipe(Effect.as(null)),
					),
				);

				if (!okResponse) {
					return null;
				}

				const data = yield* HttpClientResponse.schemaBodyJson(ExaContentsResponse)(okResponse).pipe(
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ExaExtractor",
							message: "Failed to parse API response",
							cause: error,
						}),
					),
				);

				const status = data.statuses?.find((item) => item.id === url);
				if (status?.status === "error") {
					yield* Effect.logInfo(
						`ExaExtractor: Failed to extract ${url}, error ${status.error?.tag ?? "unknown"}`,
					);
					return null;
				}

				const result = data.results.find((item) => item.url === url) ?? data.results[0];
				if (!result?.text) {
					yield* Effect.logInfo(`ExaExtractor: No text found for ${url}`);
					return null;
				}

				yield* Effect.logInfo(
					`ExaExtractor: Extracted text from ${url} (${result.text.length} bytes)`,
				);
				return { kind: "markdown", content: result.text } satisfies ExtractionResult;
			});

			return Service.of({
				isEnabled: () => !!env.EXA_API_KEY,
				extract,
			});
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}

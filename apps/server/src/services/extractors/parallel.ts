import env from "@starlight/utils/config";
import { Context, Effect, Layer, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import { ExtractionError, type ExtractionResult } from "@/services/extractors/base";

const ParallelExtractResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			title: Schema.NullOr(Schema.String),
			full_content: Schema.NullOr(Schema.String),
			excerpts: Schema.NullOr(Schema.Array(Schema.String)),
		}),
	),
	errors: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			error_type: Schema.String,
			content: Schema.String,
		}),
	),
});

export namespace ParallelExtractor {
	export interface Interface {
		readonly isEnabled: () => boolean;
		readonly extract: (url: string) => Effect.Effect<ExtractionResult | null, ExtractionError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		"starlight/extractors/ParallelExtractor",
	) {}

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const extract = Effect.fn("ParallelExtractor.extract")(function* (url: string) {
				yield* Effect.logInfo(`ParallelExtractor: Starting extraction for ${url}`);

				const request = yield* HttpClientRequest.post(
					`${env.PARALLEL_API_BASE_URL}/v1beta/extract`,
				).pipe(
					HttpClientRequest.setHeaders({
						"x-api-key": env.PARALLEL_API_KEY!,
						"parallel-beta": env.PARALLEL_EXTRACT_BETA,
					}),
					HttpClientRequest.bodyJson({
						urls: [url],
						objective:
							"Extract the main topic, key points, and a brief summary of the page content",
						full_content: false,
						excerpts: true,
					}),
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ParallelExtractor",
							message: "Failed to encode request body",
							cause: error,
						}),
					),
				);

				const response = yield* client.execute(request).pipe(
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ParallelExtractor",
							message: "API request failed",
							cause: error,
						}),
					),
				);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logInfo(
							`ParallelExtractor: API request failed for ${url}, status ${response.status}`,
						).pipe(Effect.as(null)),
					),
				);

				if (!okResponse) {
					return null;
				}

				const data = yield* HttpClientResponse.schemaBodyJson(ParallelExtractResponse)(
					okResponse,
				).pipe(
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ParallelExtractor",
							message: "Failed to parse API response",
							cause: error,
						}),
					),
				);

				const result = data.results[0];
				if (!result?.excerpts?.length) {
					yield* Effect.logInfo(`ParallelExtractor: No excerpts found for ${url}`);
					return null;
				}

				const content = result.excerpts.join("\n\n");
				yield* Effect.logInfo(
					`ParallelExtractor: Extracted ${result.excerpts.length} excerpts from ${url} (${content.length} bytes)`,
				);
				return { kind: "markdown", content } satisfies ExtractionResult;
			});

			return Service.of({
				isEnabled: () => !!env.PARALLEL_API_KEY,
				extract,
			});
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}

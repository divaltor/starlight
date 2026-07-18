import env from "@starlight/utils/config";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import {
	ExtractionError,
	type ExtractionResult,
	type SearchInput,
	type SearchResult,
} from "@/services/extractors/base";

const PARALLEL_TIMEOUT_MS = 10_000;

const ParallelExtractResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			title: Schema.optional(Schema.NullOr(Schema.String)),
			publish_date: Schema.optional(Schema.NullOr(Schema.String)),
			full_content: Schema.optional(Schema.NullOr(Schema.String)),
			excerpts: Schema.Array(Schema.String),
		}),
	),
	errors: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			error_type: Schema.String,
			http_status_code: Schema.NullOr(Schema.Number),
			content: Schema.NullOr(Schema.String),
		}),
	),
});

const ParallelSearchResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			title: Schema.optional(Schema.NullOr(Schema.String)),
			publish_date: Schema.optional(Schema.NullOr(Schema.String)),
			excerpts: Schema.Array(Schema.String),
		}),
	),
});

export namespace ParallelExtractor {
	export interface Interface {
		readonly isEnabled: () => boolean;
		readonly extract: (
			url: string,
			objective?: string,
		) => Effect.Effect<ExtractionResult | null, ExtractionError>;
		readonly search: (input: SearchInput) => Effect.Effect<SearchResult[], ExtractionError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		"starlight/extractors/ParallelExtractor",
	) {}

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const extract = Effect.fn("ParallelExtractor.extract")(function* (
				url: string,
				objective?: string,
			) {
				yield* Effect.logInfo(`ParallelExtractor: Starting extraction for ${url}`);

				const request = yield* HttpClientRequest.post(
					`${env.PARALLEL_API_BASE_URL}/v1/extract`,
				).pipe(
					HttpClientRequest.setHeaders({
						"x-api-key": env.PARALLEL_API_KEY!,
					}),
					HttpClientRequest.bodyJson({
						urls: [url],
						objective:
							objective ??
							"Extract the main article content. Exclude navigation, edit controls, media controls, sidebars, footers, and site boilerplate.",
						max_chars_total: 6_000,
						client_model: env.OPENROUTER_MODEL,
						advanced_settings: {
							fetch_policy: {
								timeout_seconds: 10,
							},
							excerpt_settings: {
								max_chars_per_result: 6_000,
							},
						},
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
					Effect.timeout(Duration.millis(PARALLEL_TIMEOUT_MS)),
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

			const search = Effect.fn("ParallelExtractor.search")(function* (input: SearchInput) {
				const maxResults = Math.min(input.maxResults ?? 3, 3);
				yield* Effect.logInfo(`ParallelExtractor: Searching for ${input.query}`);

				const request = yield* HttpClientRequest.post(
					`${env.PARALLEL_API_BASE_URL}/v1/search`,
				).pipe(
					HttpClientRequest.setHeaders({
						"x-api-key": env.PARALLEL_API_KEY!,
					}),
					HttpClientRequest.bodyJson({
						objective: input.query,
						search_queries: [input.query],
						mode: "basic",
						max_chars_total: 6_000,
						client_model: env.OPENROUTER_MODEL,
						advanced_settings: {
							fetch_policy: {
								timeout_seconds: 10,
							},
							excerpt_settings: {
								max_chars_per_result: 2_000,
							},
							max_results: maxResults,
						},
					}),
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ParallelExtractor",
							message: "Failed to encode search request body",
							cause: error,
						}),
					),
				);

				const response = yield* client.execute(request).pipe(
					Effect.timeout(Duration.millis(PARALLEL_TIMEOUT_MS)),
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ParallelExtractor",
							message: "Search API request failed",
							cause: error,
						}),
					),
				);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logInfo(
							`ParallelExtractor: Search API request failed for ${input.query}, status ${response.status}`,
						).pipe(Effect.as(null)),
					),
				);

				if (!okResponse) {
					return [];
				}

				const data = yield* HttpClientResponse.schemaBodyJson(ParallelSearchResponse)(
					okResponse,
				).pipe(
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "ParallelExtractor",
							message: "Failed to parse search API response",
							cause: error,
						}),
					),
				);

				const results: SearchResult[] = [];

				for (const result of data.results) {
					const content = result.excerpts.join("\n\n").trim();

					if (!content) {
						continue;
					}

					results.push({
						content,
						publishedDate: result.publish_date,
						source: "parallel",
						title: result.title,
						url: result.url,
					});

					if (results.length >= maxResults) {
						break;
					}
				}

				return results;
			});

			return Service.of({
				isEnabled: () => !!env.PARALLEL_API_KEY,
				extract,
				search,
			});
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}

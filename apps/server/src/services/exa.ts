import env from "@starlight/utils/config";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";

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
			}),
		),
	),
});

const ExaSearchResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			title: Schema.optional(Schema.NullOr(Schema.String)),
			publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
			text: Schema.optional(Schema.String),
			highlights: Schema.optional(Schema.Array(Schema.String)),
		}),
	),
});

export interface ExaPage {
	readonly content: string;
	readonly source: "exa";
	readonly url: string;
}

export interface ExaSearchResult {
	readonly content: string;
	readonly publishedDate?: string | null;
	readonly title?: string | null;
	readonly url: string;
}

export class ExaError extends Schema.TaggedErrorClass<ExaError>()("ExaError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {
	static fromCause(message: string, cause: unknown) {
		return new ExaError({ message, cause });
	}
}

export namespace Exa {
	export interface Interface {
		readonly lookup: (url: string) => Effect.Effect<ExaPage | null, ExaError>;
		readonly search: (query: string) => Effect.Effect<ExaSearchResult[], ExaError>;
	}

	export class Service extends Context.Service<Service, Interface>()("starlight/Exa") {}

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const apiKey = env.EXA_API_KEY;

			if (!apiKey) {
				return Service.of({
					lookup: () => Effect.succeed(null),
					search: () => Effect.succeed([]),
				});
			}

			const executeJson = Effect.fn("Exa.executeJson")(function* (path: string, body: unknown) {
				const request = yield* HttpClientRequest.post(`${env.EXA_API_BASE_URL}${path}`).pipe(
					HttpClientRequest.acceptJson,
					HttpClientRequest.setHeaders({ "x-api-key": apiKey }),
					HttpClientRequest.bodyJson(body),
					Effect.mapError((error) => ExaError.fromCause("Failed to encode Exa request", error)),
				);
				const response = yield* client.execute(request).pipe(
					Effect.timeout(Duration.millis(EXA_TIMEOUT_MS)),
					Effect.mapError((error) => ExaError.fromCause("Exa API request failed", error)),
				);
				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.mapError((error) => ExaError.fromCause("Exa API returned an error", error)),
				);
				const raw = yield* okResponse.json.pipe(
					Effect.mapError((error) => ExaError.fromCause("Failed to read Exa response", error)),
				);

				return raw;
			});

			const lookup = Effect.fn("Exa.lookup")(function* (url: string) {
				const raw = yield* executeJson("/contents", {
					urls: [url],
					text: {
						maxCharacters: 6_000,
						verbosity: "compact",
						includeSections: ["body"],
					},
					maxAgeHours: 0,
					livecrawlTimeout: EXA_TIMEOUT_MS,
				});
				const data = yield* Schema.decodeUnknownEffect(ExaContentsResponse)(raw).pipe(
					Effect.mapError((error) => ExaError.fromCause("Failed to parse Exa response", error)),
				);

				if (data.statuses?.some((status) => status.id === url && status.status === "error")) {
					return null;
				}

				const result = data.results.find((item) => item.url === url) ?? data.results[0];
				if (!result?.text) {
					return null;
				}

				return {
					content: result.text,
					source: "exa",
					url: result.url,
				} satisfies ExaPage;
			});

			const search = Effect.fn("Exa.search")(function* (query: string) {
				const raw = yield* executeJson("/search", {
					query,
					numResults: 3,
					contents: {
						highlights: { query, maxCharacters: 2_000 },
						text: { maxCharacters: 4_000 },
						livecrawlTimeout: EXA_TIMEOUT_MS,
					},
				});
				const data = yield* Schema.decodeUnknownEffect(ExaSearchResponse)(raw).pipe(
					Effect.mapError((error) => ExaError.fromCause("Failed to parse Exa response", error)),
				);

				return data.results.flatMap((result) => {
					const content = (result.highlights?.join("\n\n") || result.text || "").trim();

					return content
						? [
								{
									content,
									publishedDate: result.publishedDate,
									title: result.title,
									url: result.url,
								} satisfies ExaSearchResult,
							]
						: [];
				});
			});

			return Service.of({ lookup, search });
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}

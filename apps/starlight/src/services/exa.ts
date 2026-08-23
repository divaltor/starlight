import { Config, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";

const DEFAULT_BASE_URL = "https://api.exa.ai";
const REQUEST_TIMEOUT_MS = 30_000;

const ContentsResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			text: Schema.optional(Schema.String),
			url: Schema.String,
		}),
	),
});

const SearchResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			highlights: Schema.optional(Schema.Array(Schema.String)),
			publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
			text: Schema.optional(Schema.String),
			title: Schema.optional(Schema.NullOr(Schema.String)),
			url: Schema.String,
		}),
	),
});

export interface Page {
	readonly content: string;
	readonly url: string;
}

export interface SearchResult {
	readonly content: string;
	readonly publishedDate?: string | null;
	readonly title?: string | null;
	readonly url: string;
}

interface ContentsRequest {
	readonly text: { readonly maxCharacters: number };
	readonly urls: readonly string[];
}

interface SearchRequest {
	readonly contents: {
		readonly highlights: { readonly maxCharacters: number; readonly query: string };
		readonly text: { readonly maxCharacters: number };
	};
	readonly numResults: number;
	readonly query: string;
}

type ExaRequestBody = ContentsRequest | SearchRequest;

export class ExaError extends Schema.TaggedError<ExaError>()("ExaError", {
	cause: Schema.optional(Schema.Defect()),
	message: Schema.String,
}) {
	static fromCause(message: string, cause: unknown) {
		return new ExaError({ cause, message });
	}
}

export interface Interface {
	readonly isEnabled: () => boolean;
	readonly lookup: (url: string) => Effect.Effect<Page | null, ExaError>;
	readonly search: (query: string) => Effect.Effect<readonly SearchResult[], ExaError>;
}

export class Service extends Context.Service<Service, Interface>()("starlight/Exa") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
	Service,
	Effect.gen(function* layer() {
		const client = yield* HttpClient.HttpClient;
		const configuredApiKey = yield* Config.option(Config.redacted("EXA_API_KEY"));
		const configuredBaseUrl = yield* Config.string("EXA_API_BASE_URL").pipe(
			Config.withDefault(DEFAULT_BASE_URL),
		);
		const apiKey = configuredApiKey.pipe(
			Option.flatMap((value) => {
				const key = Redacted.value(value).trim();
				return key ? Option.some(key) : Option.none();
			}),
		);
		const baseUrl = configuredBaseUrl.trim() || DEFAULT_BASE_URL;

		if (Option.isNone(apiKey)) {
			return Service.of({
				isEnabled: () => false,
				lookup: () => Effect.succeed(null),
				search: () => Effect.succeed([]),
			});
		}

		const executeJson = Effect.fn("Exa.executeJson")(function* executeJson(
			path: string,
			body: ExaRequestBody,
		) {
			const request = yield* HttpClientRequest.post(`${baseUrl}${path}`).pipe(
				HttpClientRequest.acceptJson,
				HttpClientRequest.setHeaders({ "x-api-key": apiKey.value }),
				HttpClientRequest.bodyJson(body),
				Effect.mapError((error) => ExaError.fromCause("Failed to encode Exa request", error)),
			);
			const response = yield* client.execute(request).pipe(
				Effect.timeout(Duration.millis(REQUEST_TIMEOUT_MS)),
				Effect.mapError((error) => ExaError.fromCause("Exa request failed", error)),
			);
			const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
				Effect.mapError((error) => ExaError.fromCause("Exa rejected the request", error)),
			);

			return yield* okResponse.json.pipe(
				Effect.mapError((error) => ExaError.fromCause("Failed to read Exa response", error)),
			);
		});

		const lookup = Effect.fn("Exa.lookup")(function* lookup(url: string) {
			const raw = yield* executeJson("/contents", {
				urls: [url],
				text: { maxCharacters: 6000 },
			});
			const data = yield* Schema.decodeUnknownEffect(ContentsResponse)(raw).pipe(
				Effect.mapError((error) => ExaError.fromCause("Failed to parse Exa response", error)),
			);
			const page = data.results.find((result) => result.url === url) ?? data.results[0];

			return page?.text ? { content: page.text, url: page.url } : null;
		});

		const search = Effect.fn("Exa.search")(function* search(query: string) {
			const raw = yield* executeJson("/search", {
				contents: {
					highlights: { maxCharacters: 2000, query },
					text: { maxCharacters: 4000 },
				},
				numResults: 5,
				query,
			});
			const data = yield* Schema.decodeUnknownEffect(SearchResponse)(raw).pipe(
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
							},
						]
					: [];
			});
		});

		return Service.of({ isEnabled: () => true, lookup, search });
	}),
);

export const defaultLayer: Layer.Layer<Service> = layer.pipe(Layer.provide(FetchHttpClient.layer));

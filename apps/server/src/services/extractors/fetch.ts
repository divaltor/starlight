import { Context, Duration, Effect, Layer } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import UserAgent from "user-agents";
import { ExtractionError, type ExtractionResult } from "@/services/extractors/base";

const FETCH_TIMEOUT_MS = 10_000;

export namespace FetchExtractor {
	export interface Interface {
		readonly isEnabled: () => boolean;
		readonly extract: (url: string) => Effect.Effect<ExtractionResult | null, ExtractionError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		"starlight/extractors/FetchExtractor",
	) {}

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const extract = Effect.fn("FetchExtractor.extract")(function* (url: string) {
				yield* Effect.logInfo(`FetchExtractor: Starting extraction for ${url}`);

				const response = yield* client
					.execute(
						HttpClientRequest.get(url).pipe(
							HttpClientRequest.accept("text/markdown"),
							HttpClientRequest.setHeader("User-Agent", new UserAgent().toString()),
						),
					)
					.pipe(
						Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
						Effect.mapError((error) =>
							ExtractionError.fromCause({
								extractor: "FetchExtractor",
								message: "Fetch failed",
								cause: error,
							}),
						),
					);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logInfo(
							`FetchExtractor: Failed to fetch ${url}, status ${response.status}`,
						).pipe(Effect.as(null)),
					),
				);

				if (!okResponse) {
					return null;
				}

				const contentType = okResponse.headers["content-type"];
				const body = yield* okResponse.text.pipe(
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "FetchExtractor",
							message: "Failed to read response body",
							cause: error,
						}),
					),
				);

				if (contentType?.includes("text/markdown")) {
					yield* Effect.logInfo(
						`FetchExtractor: Extracted markdown content from ${url} (${body.length} bytes)`,
					);
					return { kind: "markdown", content: body } satisfies ExtractionResult;
				}

				yield* Effect.logInfo(
					`FetchExtractor: Extracted HTML content from ${url} (${body.length} bytes)`,
				);
				return { kind: "html", content: body } satisfies ExtractionResult;
			});

			return Service.of({
				isEnabled: () => true,
				extract,
			});
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}

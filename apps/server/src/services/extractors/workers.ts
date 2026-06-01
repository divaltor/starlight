import env from "@starlight/utils/config";
import { Context, Effect, Layer, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import {
	ExtractionError,
	type ExtractionFile,
	type ExtractionResult,
} from "@/services/extractors/base";

const WorkersExtractResponse = Schema.Struct({
	result: Schema.Array(
		Schema.Union([
			Schema.Struct({
				format: Schema.Literal("markdown"),
				data: Schema.optional(Schema.String),
			}),
			Schema.Struct({
				format: Schema.Literal("error"),
				error: Schema.optional(Schema.String),
			}),
		]),
	),
});

export namespace WorkersExtractor {
	export interface Interface {
		readonly isEnabled: () => boolean;
		readonly extract: (
			file: ExtractionFile,
		) => Effect.Effect<ExtractionResult | null, ExtractionError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		"starlight/extractors/WorkersExtractor",
	) {}

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const extract = Effect.fn("WorkersExtractor.extract")(function* (file: ExtractionFile) {
				yield* Effect.logInfo(
					`WorkersExtractor: Starting extraction for file ${file.name} (type: ${file.type})`,
				);

				const blob = new Blob([file.data], { type: file.type });
				const form = new FormData();
				form.append("files", blob, file.name);

				const response = yield* client
					.execute(
						HttpClientRequest.post(
							`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`,
						).pipe(
							HttpClientRequest.bearerToken(env.CLOUDFLARE_API_TOKEN!),
							HttpClientRequest.bodyFormData(form),
						),
					)
					.pipe(
						Effect.mapError((error) =>
							ExtractionError.fromCause({
								extractor: "WorkersExtractor",
								message: "Cloudflare API request failed",
								cause: error,
							}),
						),
					);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logInfo(
							`WorkersExtractor: Cloudflare API request failed for ${file.name}, status ${response.status}`,
						).pipe(Effect.as(null)),
					),
				);

				if (!okResponse) {
					return null;
				}

				const results = yield* HttpClientResponse.schemaBodyJson(WorkersExtractResponse)(
					okResponse,
				).pipe(
					Effect.mapError((error) =>
						ExtractionError.fromCause({
							extractor: "WorkersExtractor",
							message: "Failed to parse response",
							cause: error,
						}),
					),
				);

				const first = results.result[0];
				if (!first || first.format !== "markdown" || !first.data) {
					yield* Effect.logInfo(`WorkersExtractor: Invalid or error result for ${file.name}`);
					return null;
				}

				yield* Effect.logInfo(
					`WorkersExtractor: Successfully extracted markdown from ${file.name} (${first.data.length} bytes)`,
				);
				return { kind: "markdown", content: first.data } satisfies ExtractionResult;
			});

			return Service.of({
				isEnabled: () => !!env.CLOUDFLARE_ACCOUNT_ID && !!env.CLOUDFLARE_API_TOKEN,
				extract,
			});
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}

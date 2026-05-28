import { HttpBody, HttpClient, HttpClientResponse } from "@effect/platform";
import env from "@starlight/utils/config";
import { Effect, Schema } from "effect";
import type { ExtractionResult } from "@/services/extractors/base";

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

const extract = Effect.fn("ParallelExtractor.extract")(function* (url: string) {
	yield* Effect.logInfo(`ParallelExtractor: Starting extraction for ${url}`);
	const client = yield* HttpClient.HttpClient;

	const body = yield* HttpBody.json({
		urls: [url],
		objective: "Extract the main topic, key points, and a brief summary of the page content",
		full_content: false,
		excerpts: true,
	}).pipe(
		Effect.catchAll((error) =>
			Effect.logError("ParallelExtractor: Failed to encode request body", { error, url }).pipe(
				Effect.as(null),
			),
		),
	);

	if (!body) {
		return null;
	}

	const response = yield* client
		.post(`${env.PARALLEL_API_BASE_URL}/v1beta/extract`, {
			headers: {
				"x-api-key": env.PARALLEL_API_KEY!,
				"parallel-beta": env.PARALLEL_EXTRACT_BETA,
			},
			body,
		})
		.pipe(
			Effect.catchAll((error) =>
				Effect.logError("ParallelExtractor: API request failed", { error, url }).pipe(
					Effect.as(null),
				),
			),
		);

	if (!response) {
		return null;
	}

	const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
		Effect.catchAll(() =>
			Effect.logInfo(
				`ParallelExtractor: API request failed for ${url}, status ${response.status}`,
			).pipe(Effect.as(null)),
		),
	);

	if (!okResponse) {
		return null;
	}

	const data = yield* HttpClientResponse.schemaBodyJson(ParallelExtractResponse)(okResponse).pipe(
		Effect.catchAll((error) =>
			Effect.logError("ParallelExtractor: Failed to parse API response", { error, url }).pipe(
				Effect.as(null),
			),
		),
	);

	const result = data?.results[0];
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

export namespace ParallelExtractor {
	export class Service extends Effect.Service<Service>()("starlight/extractors/ParallelExtractor", {
		effect: Effect.succeed({
			isEnabled: () => !!env.PARALLEL_API_KEY,
			extract,
		}),
	}) {}
}

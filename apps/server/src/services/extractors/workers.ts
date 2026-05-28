import { HttpBody, HttpClient, HttpClientResponse } from "@effect/platform";
import env from "@starlight/utils/config";
import { Effect, Schema } from "effect";
import type { ExtractionFile, ExtractionResult } from "@/services/extractors/base";

const WorkersExtractResponse = Schema.Struct({
	result: Schema.Array(
		Schema.Union(
			Schema.Struct({
				format: Schema.Literal("markdown"),
				data: Schema.optional(Schema.String),
			}),
			Schema.Struct({
				format: Schema.Literal("error"),
				error: Schema.optional(Schema.String),
			}),
		),
	),
});

const extract = Effect.fn("WorkersExtractor.extract")(function* (file: ExtractionFile) {
	yield* Effect.logInfo(
		`WorkersExtractor: Starting extraction for file ${file.name} (type: ${file.type})`,
	);
	const client = yield* HttpClient.HttpClient;

	const blob = new Blob([file.data], { type: file.type });
	const form = new FormData();
	form.append("files", blob, file.name);

	const response = yield* client
		.post(
			`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`,
			{
				headers: {
					Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				},
				body: HttpBody.formData(form),
			},
		)
		.pipe(
			Effect.catchAll((error) =>
				Effect.logError("WorkersExtractor: Cloudflare API request failed", {
					error,
					fileName: file.name,
				}).pipe(Effect.as(null)),
			),
		);

	if (!response) {
		return null;
	}

	const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
		Effect.catchAll(() =>
			Effect.logInfo(
				`WorkersExtractor: Cloudflare API request failed for ${file.name}, status ${response.status}`,
			).pipe(Effect.as(null)),
		),
	);

	if (!okResponse) {
		return null;
	}

	const results = yield* HttpClientResponse.schemaBodyJson(WorkersExtractResponse)(okResponse).pipe(
		Effect.catchAll((error) =>
			Effect.logError("WorkersExtractor: Failed to parse response", {
				error,
				fileName: file.name,
			}).pipe(Effect.as(null)),
		),
	);

	const first = results?.result[0];
	if (!first || first.format !== "markdown" || !first.data) {
		yield* Effect.logInfo(`WorkersExtractor: Invalid or error result for ${file.name}`);
		return null;
	}

	yield* Effect.logInfo(
		`WorkersExtractor: Successfully extracted markdown from ${file.name} (${first.data.length} bytes)`,
	);
	return { kind: "markdown", content: first.data } satisfies ExtractionResult;
});

export namespace WorkersExtractor {
	export class Service extends Effect.Service<Service>()("starlight/extractors/WorkersExtractor", {
		effect: Effect.succeed({
			isEnabled: () => !!env.CLOUDFLARE_ACCOUNT_ID && !!env.CLOUDFLARE_API_TOKEN,
			extract,
		}),
	}) {}
}

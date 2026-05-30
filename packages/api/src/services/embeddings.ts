import { HttpBody, HttpClient, HttpClientResponse } from "@effect/platform";
import env from "@starlight/utils/config";
import { Effect, Schema } from "effect";

const EmbeddingsResponse = Schema.Struct({
	image: Schema.NullOr(Schema.Array(Schema.Number)),
	text: Schema.Array(Schema.Number),
});

const TextEmbeddingsResponse = Schema.Struct({
	text: Schema.Array(Schema.Number),
});

const generate = Effect.fn("EmbeddingsService.generate")(function* (
	image: string,
	tags: string[],
	requestId?: string,
) {
	yield* Effect.logInfo(`EmbeddingsService: Generating embeddings for ${image}`);
	const client = yield* HttpClient.HttpClient;

	const body = yield* HttpBody.json({
		image,
		tags,
	}).pipe(
		Effect.catchAll((error) =>
			Effect.logError("EmbeddingsService: Failed to encode request body", { error, image }).pipe(
				Effect.as(null),
			),
		),
	);

	if (!body) {
		return null;
	}

	const response = yield* client
		.post(`${env.ML_BASE_URL}/v1/embeddings`, {
			headers: {
				"Content-Type": "application/json",
				"X-API-Token": env.ML_API_TOKEN!,
				"X-Request-Id": requestId ?? Bun.randomUUIDv7(),
			},
			body,
		})
		.pipe(
			Effect.catchAll((error) =>
				Effect.logError("EmbeddingsService: API request failed", { error, image }).pipe(
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
				`EmbeddingsService: API request failed for ${image}, status ${response.status}`,
			).pipe(Effect.as(null)),
		),
	);

	if (!okResponse) {
		return null;
	}

	const data = yield* HttpClientResponse.schemaBodyJson(EmbeddingsResponse)(okResponse).pipe(
		Effect.catchAll((error) =>
			Effect.logError("EmbeddingsService: Failed to parse API response", { error, image }).pipe(
				Effect.as(null),
			),
		),
	);

	if (!data) {
		return null;
	}

	yield* Effect.logInfo(`EmbeddingsService: Successfully generated embeddings for ${image}`);
	return {
		image: data.image,
		text: data.text,
	};
});

const generateText = Effect.fn("EmbeddingsService.generateText")(function* (
	query: string,
	requestId?: string,
) {
	yield* Effect.logInfo("EmbeddingsService: Generating text embeddings");
	const client = yield* HttpClient.HttpClient;

	const body = yield* HttpBody.json({
		tags: query,
		encoding_mode: "retrieval.query",
	}).pipe(
		Effect.catchAll((error) =>
			Effect.logError("EmbeddingsService: Failed to encode request body", { error }).pipe(
				Effect.as(null),
			),
		),
	);

	if (!body) {
		return null;
	}

	const response = yield* client
		.post(`${env.ML_BASE_URL}/v1/embeddings`, {
			headers: {
				"Content-Type": "application/json",
				"X-API-Token": env.ML_API_TOKEN!,
				"X-Request-Id": requestId ?? Bun.randomUUIDv7(),
			},
			body,
		})
		.pipe(
			Effect.catchAll((error) =>
				Effect.logError("EmbeddingsService: API request failed", { error }).pipe(Effect.as(null)),
			),
		);

	if (!response) {
		return null;
	}

	const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
		Effect.catchAll(() =>
			Effect.logInfo(`EmbeddingsService: API request failed, status ${response.status}`).pipe(
				Effect.as(null),
			),
		),
	);

	if (!okResponse) {
		return null;
	}

	const data = yield* HttpClientResponse.schemaBodyJson(TextEmbeddingsResponse)(okResponse).pipe(
		Effect.catchAll((error) =>
			Effect.logError("EmbeddingsService: Failed to parse API response", { error }).pipe(
				Effect.as(null),
			),
		),
	);

	if (!data) {
		return null;
	}

	yield* Effect.logInfo("EmbeddingsService: Successfully generated text embeddings");
	return data.text;
});

export namespace EmbeddingsService {
	export class Service extends Effect.Service<Service>()("starlight/EmbeddingsService", {
		effect: Effect.succeed({
			isEnabled: () => !!(env.ML_BASE_URL && env.ML_API_TOKEN),
			generate,
			generateText,
		}),
	}) {}
}

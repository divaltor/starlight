import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import UserAgent from "user-agents";
import type { ExtractionResult } from "@/services/extractors/base";

const extract = Effect.fn("FetchExtractor.extract")(function* (url: string) {
	yield* Effect.logInfo(`FetchExtractor: Starting extraction for ${url}`);
	const client = yield* HttpClient.HttpClient;

	const response = yield* client
		.get(url, {
			headers: {
				Accept: "text/markdown",
				"User-Agent": new UserAgent().toString(),
			},
		})
		.pipe(
			Effect.catchAll((error) =>
				Effect.logError("FetchExtractor: Fetch failed", { error, url }).pipe(Effect.as(null)),
			),
		);

	if (!response) {
		return null;
	}

	const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
		Effect.catchAll(() =>
			Effect.logInfo(`FetchExtractor: Failed to fetch ${url}, status ${response.status}`).pipe(
				Effect.as(null),
			),
		),
	);

	if (!okResponse) {
		return null;
	}

	const contentType = okResponse.headers["content-type"];
	const body = yield* okResponse.text.pipe(
		Effect.catchAll((error) =>
			Effect.logError("FetchExtractor: Failed to read response body", { error, url }).pipe(
				Effect.as(null),
			),
		),
	);

	if (!body) {
		return null;
	}

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

export namespace FetchExtractor {
	export class Service extends Effect.Service<Service>()("starlight/extractors/FetchExtractor", {
		effect: Effect.succeed({
			isEnabled: () => true,
			extract,
		}),
	}) {}
}

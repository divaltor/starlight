import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchExtractor } from "@/services/extractors/fetch";
import { WorkersExtractor } from "@/services/extractors/workers";
import { ParallelExtractor } from "@/services/extractors/parallel";

export const extractMarkdownEffect = Effect.fn("extractMarkdown")(function* (url: string) {
	const fetchExtractor = yield* FetchExtractor.Service;
	const workersExtractor = yield* WorkersExtractor.Service;
	const parallelExtractor = yield* ParallelExtractor.Service;

	const fetchResult = yield* fetchExtractor.extract(url);

	if (fetchResult?.kind === "markdown") {
		return fetchResult.content;
	}

	if (fetchResult?.kind === "html" && workersExtractor.isEnabled()) {
		const workersResult = yield* workersExtractor.extract({
			name: "page.html",
			data: fetchResult.content,
			type: "text/html",
		});

		if (workersResult) {
			return workersResult.content;
		}
	}

	if (parallelExtractor.isEnabled()) {
		const parallelResult = yield* parallelExtractor.extract(url);

		if (parallelResult) {
			return parallelResult.content;
		}
	}

	return null;
});

const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		FetchHttpClient.layer,
		FetchExtractor.Service.Default,
		WorkersExtractor.Service.Default,
		ParallelExtractor.Service.Default,
	),
);

export function extractMarkdown(url: string): Promise<string | null> {
	return runtime.runPromise(extractMarkdownEffect(url));
}

import { Effect } from "effect";
import { ExtractionError, type SearchResult } from "@/services/extractors/base";
import { ExaExtractor } from "@/services/extractors/exa";
import { ParallelExtractor } from "@/services/extractors/parallel";
import { runtime } from "@/services/runtime";

const MAX_SEARCH_RESULTS = 3;

const ignoreSearchError = (error: ExtractionError) =>
	Effect.logError(`${error.extractor}: ${error.message}`, { error }).pipe(Effect.as([]));

export function isSearchEnabled(): boolean {
	return runtime.runSync(
		Effect.gen(function* () {
			const exaExtractor = yield* ExaExtractor.Service;
			const parallelExtractor = yield* ParallelExtractor.Service;

			return exaExtractor.isEnabled() || parallelExtractor.isEnabled();
		}),
	);
}

export const searchWebEffect = Effect.fn("searchWeb")(function* (query: string) {
	const exaExtractor = yield* ExaExtractor.Service;
	const parallelExtractor = yield* ParallelExtractor.Service;

	if (exaExtractor.isEnabled()) {
		const exaResults = yield* exaExtractor
			.search({ query, maxResults: MAX_SEARCH_RESULTS })
			.pipe(Effect.catch(ignoreSearchError));

		if (exaResults.length > 0) {
			return exaResults;
		}
	}

	if (parallelExtractor.isEnabled()) {
		return yield* parallelExtractor
			.search({ query, maxResults: MAX_SEARCH_RESULTS })
			.pipe(Effect.catch(ignoreSearchError));
	}

	return [] satisfies SearchResult[];
});

export function searchWeb(query: string): Promise<SearchResult[]> {
	return runtime.runPromise(searchWebEffect(query));
}

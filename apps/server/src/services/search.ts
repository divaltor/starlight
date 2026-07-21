import { Effect } from "effect";
import { ExtractionError, type SearchResult } from "@/services/extractors/base";
import { ExaExtractor } from "@/services/extractors/exa";
import { runtime } from "@/services/runtime";

const MAX_SEARCH_RESULTS = 3;

export const searchWebEffect = Effect.fn("searchWeb")(function* (query: string) {
	const exaExtractor = yield* ExaExtractor.Service;

	return yield* exaExtractor
		.search({ query, maxResults: MAX_SEARCH_RESULTS })
		.pipe(
			Effect.catch((error: ExtractionError) =>
				Effect.logError(`${error.extractor}: ${error.message}`, { error }).pipe(Effect.as([])),
			),
		);
});

export function searchWeb(query: string): Promise<SearchResult[]> {
	return runtime.runPromise(searchWebEffect(query));
}

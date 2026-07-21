import { Effect } from "effect";
import { Exa, type ExaPage, type ExaSearchResult } from "@/services/exa";
import { runtime } from "@/services/runtime";

export const lookupWebPageEffect = Effect.fn("lookupWebPage")(function* (url: string) {
	const exa = yield* Exa.Service;

	return yield* exa
		.lookup(url)
		.pipe(
			Effect.catch((error) =>
				Effect.logError("Exa page lookup failed", { error, url }).pipe(Effect.as(null)),
			),
		);
});

export const searchWebEffect = Effect.fn("searchWeb")(function* (query: string) {
	const exa = yield* Exa.Service;

	return yield* exa
		.search(query)
		.pipe(
			Effect.catch((error) =>
				Effect.logError("Exa web search failed", { error, query }).pipe(Effect.as([])),
			),
		);
});

export function lookupWebPage(url: string): Promise<ExaPage | null> {
	return runtime.runPromise(lookupWebPageEffect(url));
}

export function searchWeb(query: string): Promise<ExaSearchResult[]> {
	return runtime.runPromise(searchWebEffect(query));
}

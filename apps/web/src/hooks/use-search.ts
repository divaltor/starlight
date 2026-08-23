import type { SearchPageResult, TweetData } from "@starlight/api/types/tweets";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "@/utils/orpc";

const EMPTY_RESULTS: TweetData[] = [];

interface UseSearchOptions {
	limit?: number;
	ownOnly?: boolean;
	query: string;
}

export function useSearch(options: UseSearchOptions) {
	const { query, limit = 30, ownOnly = false } = options;

	const { data, error, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, status } =
		useInfiniteQuery(
			orpc.tweets.search.infiniteOptions({
				input: (pageParam: string | null | undefined) => ({
					query,
					cursor: pageParam ?? undefined,
					limit,
					ownOnly,
				}),
				queryKey: ["search", { query, ownOnly }],
				initialPageParam: null,
				getNextPageParam: (lastPage: SearchPageResult) => lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
				enabled: !!query.trim(),
			}),
		);

	const isEnabled = !!query.trim();
	const results = data?.pages.flatMap((page) => page.results) ?? EMPTY_RESULTS;

	return {
		results,
		isLoading: isEnabled && status === "pending",
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	};
}

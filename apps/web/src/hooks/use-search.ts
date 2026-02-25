import type { SearchPageResult, TweetData } from "@starlight/api/src/types/tweets";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "@/utils/orpc";

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
				input: (pageParam: string | undefined) => ({
					query,
					cursor: pageParam,
					limit,
					ownOnly,
				}),
				queryKey: ["search", { query, ownOnly }],
				initialPageParam: undefined,
				getNextPageParam: (lastPage: SearchPageResult) => lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
				enabled: !!query.trim(),
			}),
		);

	const isEnabled = !!query.trim();

	return {
		results: data?.pages.flatMap((page) => page.results) ?? ([] as TweetData[]),
		isLoading: isEnabled && status === "pending",
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	};
}

import type { SearchPageResult, PostData } from "@starlight/api/src/types/posts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "@/utils/orpc";

const EMPTY_RESULTS: PostData[] = [];

interface UseSearchOptions {
	limit?: number;
	ownOnly?: boolean;
	query: string;
}

export function useSearch(options: UseSearchOptions) {
	const { query, limit = 30, ownOnly = false } = options;

	const { data, error, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, status } =
		useInfiniteQuery(
			orpc.posts.search.infiniteOptions({
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

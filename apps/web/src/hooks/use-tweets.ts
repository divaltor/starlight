import type { TweetData, TweetsPageResult } from "@starlight/api/src/types/tweets";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { orpc } from "@/utils/orpc";

const EMPTY_TWEETS: TweetData[] = [];

interface UseTweetsOptions {
	limit?: number;
	username?: string;
}

export function useTweets(options: UseTweetsOptions = {}) {
	const { username, limit = 30 } = options;

	const { data, error, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, status } =
		useInfiniteQuery(
			orpc.tweets.list.infiniteOptions({
				input: (pageParam: string | undefined) => ({
					username,
					cursor: pageParam,
					limit,
				}),
				queryKey: ["tweets", { username }],
				initialPageParam: undefined,
				getNextPageParam: (lastPage: TweetsPageResult) => lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
			}),
		);
	const tweets = useMemo(
		() => data?.pages.flatMap((page) => page.tweets) ?? EMPTY_TWEETS,
		[data?.pages],
	);

	return {
		tweets,
		isLoading: status === "pending",
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	};
}

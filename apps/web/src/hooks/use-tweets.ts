import type {
	TweetData,
	TweetsPageResult,
} from "@starlight/api/src/types/tweets";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "@/utils/orpc";

type UseTweetsOptions = {
	username?: string;
	limit?: number;
};

export function useTweets(options: UseTweetsOptions = {}) {
	const { username, limit = 30 } = options;

	const {
		data,
		error,
		fetchNextPage,
		hasNextPage,
		isFetching,
		isFetchingNextPage,
		status,
	} = useInfiniteQuery(
		orpc.tweets.list.infiniteOptions({
			input: (pageParam: string | undefined) => ({
				username,
				cursor: pageParam,
				limit,
			}),
			queryKey: ["tweets", { username }],
			initialPageParam: undefined,
			getNextPageParam: (lastPage: TweetsPageResult) =>
				lastPage.nextCursor ?? undefined,
			retry: false,
			gcTime: 10 * 60 * 1000,
		})
	);

	return {
		tweets: data?.pages.flatMap((page) => page.tweets) ?? ([] as TweetData[]),
		isLoading: status === "pending",
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	};
}

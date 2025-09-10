import { useInfiniteQuery } from "@tanstack/react-query";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import { getCollectionTweets } from "@/routes/api/collections/$id";
import type { TweetData, TweetsPageResult } from "@/types/tweets";

interface UseCollectionTweetsOptions {
	id: string; // collectionShare id
	limit?: number;
	retry?: boolean | number;
}

export function useCollectionTweets(options: UseCollectionTweetsOptions) {
	const { id, limit = 30, retry = 3 } = options;
	const { rawInitData } = useTelegramContext();

	const queryKey = ["collection-tweets", { id, limit }];

	const {
		data,
		error,
		fetchNextPage,
		hasNextPage,
		isFetching,
		isFetchingNextPage,
		status,
	} = useInfiniteQuery<TweetsPageResult>({
		queryKey,
		queryFn: async ({ pageParam }) => {
			return await getCollectionTweets({
				headers: { Authorization: rawInitData ?? "" },
				data: { id, cursor: pageParam as string | undefined, limit },
			});
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		retry,
		enabled: !!id,
	});

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

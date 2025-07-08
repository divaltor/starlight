import { useInfiniteQuery } from "@tanstack/react-query";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import { getUserTweets } from "@/routes/api/tweets";
import type { DateFilter } from "@/types/dates";

type UseTweetsOptions = {
	dateFilter?: DateFilter;
};

export function useTweets(options: UseTweetsOptions = {}) {
	const { dateFilter } = options;
	const { rawInitData } = useTelegramContext();

	const {
		data,
		error,
		fetchNextPage,
		hasNextPage,
		isFetching,
		isFetchingNextPage,
		status,
	} = useInfiniteQuery({
		queryKey: ["tweets", dateFilter],
		queryFn: async ({ pageParam }) => {
			const result = await getUserTweets({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					cursor: pageParam,
					dateFilter,
				},
			});

			return result;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => {
			return lastPage.nextCursor;
		},
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return {
		tweets: data?.pages.flatMap((page) => page.tweets) ?? [],
		isLoading: status === "pending",
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	};
}

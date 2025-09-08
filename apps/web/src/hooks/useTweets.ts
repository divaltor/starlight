import { useInfiniteQuery } from "@tanstack/react-query";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import { getProfileShare as getPublicProfileShare } from "@/routes/api/public/share/profile/$slug";
import { getUserTweets } from "@/routes/api/tweets";
import type { TweetData, TweetsPageResult } from "@/types/tweets";

interface UseTweetsOptions {
	// Source of tweets
	source?: "user" | "shared-profile";
	// Required when source = "shared-profile"
	slug?: string;
	limit?: number;
	retry?: boolean | number;
}

export function useTweets(options: UseTweetsOptions = {}) {
	const { source = "user", slug, limit = 30, retry = 3 } = options;
	const { rawInitData } = useTelegramContext();

	const queryKey = [
		"tweets",
		{
			source,
			slug: slug ?? null,
			limit,
		},
	];

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
			if (source === "user") {
				return await getUserTweets({
					headers: { Authorization: rawInitData ?? "" },
					data: { cursor: pageParam as string | undefined, limit },
				});
			}

			if (source === "shared-profile") {
				if (!slug)
					throw new Error("Slug is required for shared-profile tweets");

				return await getPublicProfileShare({
					data: { slug, cursor: pageParam as string | undefined, limit },
				});
			}

			throw new Error("Unknown tweets source");
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		retry,
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

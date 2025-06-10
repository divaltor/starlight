import { getUserTweets } from "@/routes/api/tweets";
import { useInfiniteQuery } from "@tanstack/react-query";
import { initData, useSignal } from "@telegram-apps/sdk-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
// @ts-ignore - dependency exists but TS can't find it
import { useInView } from "react-intersection-observer";

type TweetData = {
	id: string;
	tweetUrl: string;
	artist: string;
	date: string;
	photos: Array<{
		id: string;
		url: string;
		alt: string;
	}>;
	photoCount: number;
	firstPhotoId?: string;
	isMultiImage: boolean;
};

export function useTweets() {
	const user = useSignal(initData.user);
	const stableTweetsRef = useRef<TweetData[]>([]);
	const lastDataLengthRef = useRef(0);

	// Intersection observer for infinite scrolling
	const { ref: loadMoreRef, inView } = useInView({
		threshold: 0.1,
		rootMargin: "200px",
		triggerOnce: false,
	});

	const {
		data,
		error,
		fetchNextPage,
		hasNextPage,
		isFetching,
		isFetchingNextPage,
		status,
	} = useInfiniteQuery({
		queryKey: ["tweets", user?.id],
		queryFn: async ({ pageParam }) => {
			if (!user?.id) {
				throw new Error("No Telegram user ID available");
			}

			const result = await getUserTweets({
				data: {
					telegramId: user.id,
					cursor: pageParam,
					limit: 30,
				},
			});

			if (!result.success) {
				throw new Error(result.error || "Failed to fetch tweets");
			}

			return result;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => {
			return lastPage.pagination.hasNextPage
				? lastPage.pagination.nextCursor
				: undefined;
		},
		enabled: !!user?.id,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		structuralSharing: false,
	});

	// Auto-fetch next page when load more element comes into view
	useEffect(() => {
		if (inView && hasNextPage && !isFetchingNextPage && !isFetching) {
			fetchNextPage();
		}
	}, [inView, hasNextPage, isFetchingNextPage, isFetching, fetchNextPage]);

	// Create stable tweets array that only grows, never shuffles
	const tweets = useMemo(() => {
		if (!data?.pages || data.pages.length === 0) {
			return stableTweetsRef.current;
		}

		const allTweets = data.pages.flatMap((page) => page.tweets);

		// Only update if we have genuinely new data
		if (allTweets.length > lastDataLengthRef.current) {
			// Create a new array that preserves existing order and only appends new items
			const existingTweetIds = new Set(
				stableTweetsRef.current.map((t) => t.id),
			);
			const newTweets = allTweets.filter(
				(tweet) => !existingTweetIds.has(tweet.id),
			);

			if (newTweets.length > 0) {
				stableTweetsRef.current = [...stableTweetsRef.current, ...newTweets];
				lastDataLengthRef.current = allTweets.length;
			}
		}

		return stableTweetsRef.current;
	}, [data?.pages]);

	const tweetMap = useMemo(() => {
		const map = new Map();
		tweets.forEach((tweet, index) => {
			map.set(tweet.id, { ...tweet, index });
		});
		return map;
	}, [tweets]);

	// Helper function to manually trigger next page load
	const loadMore = useCallback(() => {
		if (hasNextPage && !isFetchingNextPage && !isFetching) {
			fetchNextPage();
		}
	}, [hasNextPage, isFetchingNextPage, isFetching, fetchNextPage]);

	return {
		tweets,
		tweetMap,
		loadMoreRef,
		loadMore,
		isLoading: status === "pending",
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	};
}

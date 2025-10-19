import type { TweetData, TweetsPageResult } from "@starlight/api/types/tweets";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback, useEffect } from "react";
import NotFound from "@/components/not-found";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { useTweets } from "@/hooks/use-tweets";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { orpc } from "@/utils/orpc";

function TwitterArtViewer() {
	const { updateButtons } = useTelegramContext();
	const router = useRouter();

	useEffect(() => {
		// TODO: Add condition when we don't have any posts available to parse or even didn't setup a bot yet.
		updateButtons({
			mainButton: {
				state: "visible",
				text: "Publications",
				action: {
					type: "navigate",
					payload: "/publications",
				},
			},
		});

		return () => {
			updateButtons({
				mainButton: { state: "hidden" },
				secondaryButton: { state: "hidden" },
			});
		};
	}, [
		// TODO: Add condition when we don't have any posts available to parse or even didn't setup a bot yet.
		updateButtons,
	]);

	const {
		tweets,
		isLoading,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	} = useTweets();
	const infiniteLoader = useInfiniteLoader(
		async (_startIndex: number, _stopIndex: number, _items: any[]) => {
			if (hasNextPage && !isFetchingNextPage) {
				await fetchNextPage();
			}
		},
		{
			isItemLoaded: (index, items) => !!items[index],
			minimumBatchSize: 30,
			threshold: 5,
		}
	);

	const renderMasonryItem = useCallback(
		({ data, width }: { data: TweetData; width: number }) => (
			<div className="mb-1" style={{ width }}>
				<TweetImageGrid tweet={data} />
			</div>
		),
		[]
	);

	// Show error state
	if (error) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<div className="prose text-center">
					<h2 className="font-semibold text-gray-900 text-xl">
						Failed to load tweets
					</h2>
					<p className="mt-2 text-gray-600">
						{error instanceof Error ? error.message : "An error occurred"}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen p-4">
			{!isLoading && tweets.length === 0 && (
				<NotFound
					description="Did you setup cookies? Try again later."
					primaryAction={{
						label: "Go to Settings",
						onClick: () => {
							router.navigate({ to: "/settings" });
						},
						onMouseEnter: () => {
							router.preloadRoute({ to: "/settings" });
						},
					}}
					title="No photos found"
				/>
			)}

			{/* Masonry Grid */}
			{tweets.length > 0 && (
				<div className="mx-auto max-w-7xl">
					<Masonry
						columnGutter={16}
						items={tweets}
						onRender={infiniteLoader}
						render={renderMasonryItem}
					/>
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute("/app")({
	loader: async ({ context: { queryClient } }) => {
		// Skip prefetch on server to avoid context errors for user-specific data in TMA
		if (import.meta.env.SSR) {
			return;
		}

		await queryClient.fetchInfiniteQuery(
			orpc.tweets.list.infiniteOptions({
				input: (pageParam: string | undefined) => ({
					cursor: pageParam,
					limit: 30,
				}),
				queryKey: ["tweets", { username: undefined }],
				initialPageParam: undefined,
				getNextPageParam: (lastPage: TweetsPageResult) =>
					lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
			})
		);
	},
	component: TwitterArtViewer,
});

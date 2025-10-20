import type { TweetData, TweetsPageResult } from "@starlight/api/types/tweets";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
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
				color: "#ffd6a7",
				textColor: "#9f2d00",
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
				<NotFound
					description="An error occurred while loading tweets. Please try again later."
					icon={<AlertTriangle className="size-10 text-base-content/20" />}
					title="Failed to load tweets (｡•́︿•̀｡)"
				/>
			</div>
		);
	}

	return (
		<div className="flex min-h-screen flex-col p-4">
			{!isLoading && tweets.length === 0 && (
				<div className="flex flex-1 items-center justify-center">
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
				</div>
			)}

			{/* Masonry Grid */}
			{tweets.length > 0 && (
				<div className="flex-1">
					<div className="mx-auto max-w-7xl">
						<Masonry
							columnGutter={16}
							items={tweets}
							onRender={infiniteLoader}
							render={renderMasonryItem}
						/>
					</div>
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

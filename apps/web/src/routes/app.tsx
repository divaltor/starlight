import { createFileRoute } from "@tanstack/react-router";
import { Filter } from "lucide-react";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback, useEffect } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { useTweets } from "@/hooks/useTweets";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";

function TwitterArtViewer() {
	const { updateButtons } = useTelegramContext();

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
				mainButton: {
					state: "hidden",
				},
			});
		};
	}, [updateButtons]);

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
		},
	);

	const renderMasonryItem = useCallback(
		({ data, width }: { data: (typeof tweets)[0]; width: number }) => {
			return (
				<div style={{ width }} className="mb-1">
					<TweetImageGrid
						id={data.id}
						artist={data.artist}
						date={data.date}
						photos={data.photos}
						showActions={false}
						slotTweetId={data.id}
						sourceUrl={data.sourceUrl}
					/>
				</div>
			);
		},
		[],
	);

	// Show error state
	if (error) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<div className="text-center">
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
		<div className="min-h-screen bg-gray-50 p-4">
			{/* Header with Filters */}
			<div className="mx-auto mb-8 max-w-7xl">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h1 className="font-bold text-3xl text-gray-900">
							Twitter Art Gallery
						</h1>
					</div>
				</div>
			</div>

			{/* Loading Skeleton */}
			{isLoading && (
				<div className="mx-auto max-w-7xl">
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
						{Array.from({ length: 12 }).map((_, i) => (
							<Skeleton
								// biome-ignore lint/suspicious/noArrayIndexKey: Don't care
								key={i}
								className={`rounded-lg ${
									i % 3 === 0 ? "h-80" : i % 3 === 1 ? "h-60" : "h-96"
								}`}
							/>
						))}
					</div>
				</div>
			)}

			{/* No Results */}
			{!isLoading && tweets.length === 0 && (
				<div className="flex flex-col items-center justify-center py-16">
					<Filter className="mb-4 h-16 w-16 text-gray-400" />
					<h3 className="mb-2 font-medium text-gray-900 text-xl">
						No matching posts found
					</h3>
					<p className="max-w-md text-center text-gray-600">
						Try adjusting your filters or reset them to see all posts.
					</p>
				</div>
			)}

			{/* Masonry Grid */}
			{tweets.length > 0 && (
				<div className="mx-auto max-w-7xl">
					<Masonry
						items={tweets}
						render={renderMasonryItem}
						columnGutter={16}
						onRender={infiniteLoader}
					/>
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute("/app")({
	component: TwitterArtViewer,
});

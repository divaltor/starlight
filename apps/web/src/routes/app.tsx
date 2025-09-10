import { createFileRoute } from "@tanstack/react-router";
import { BookmarkPlus, Filter } from "lucide-react";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback, useEffect } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCollectionMutations } from "@/hooks/useCollectionMutations";
import { useCollections } from "@/hooks/useCollections";
import { useTweets } from "@/hooks/useTweets";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import type { TweetData } from "@/types/tweets";

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
			secondaryButton: {
				state: "visible",
				text: "Collections",
				action: {
					type: "navigate",
					payload: "/collections",
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
	const { collections } = useCollections();
	const { addTweet, adding } = useCollectionMutations();

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
		({ data, width }: { data: TweetData; width: number }) => {
			const handleSave = () => {
				addTweet({
					tweetId: data.id,
					// If multiple collections exist, for now just use first; future: dropdown
					collectionId:
						collections.length === 1 ? collections[0].id : undefined,
					nameIfCreate: "Favorites",
				});
			};

			return (
				<div className="group relative mb-1" style={{ width }}>
					<TweetImageGrid
						artist={data.artist}
						date={data.date}
						id={data.id}
						photos={data.photos}
						showActions={false}
						slotTweetId={data.id}
						sourceUrl={data.sourceUrl}
					/>
					<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
						<Button
							className="h-7 w-7 bg-white/80 p-0 text-gray-800 shadow-sm hover:bg-white"
							disabled={adding}
							onClick={(e) => {
								e.stopPropagation();
								handleSave();
							}}
							size="sm"
							variant="ghost"
						>
							<BookmarkPlus className="h-4 w-4" />
						</Button>
					</div>
				</div>
			);
		},
		[addTweet, adding, collections]
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
			{/* Loading Skeleton */}
			{isLoading && (
				<div className="mx-auto max-w-7xl">
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
						{Array.from({ length: 12 }).map((_, i) => (
							<Skeleton
								className={`rounded-lg ${
									i % 3 === 0 ? "h-80" : i % 3 === 1 ? "h-60" : "h-96"
								}`}
								key={i}
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
	component: TwitterArtViewer,
});

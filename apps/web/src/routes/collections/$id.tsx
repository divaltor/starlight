import { createFileRoute } from "@tanstack/react-router";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback, useEffect } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { useCollectionTweets } from "@/hooks/useCollectionTweets";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import type { TweetData } from "@/types/tweets";

function CollectionDetail() {
	const { id } = Route.useParams();
	const { updateButtons } = useTelegramContext();
	const {
		tweets,
		isLoading,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	} = useCollectionTweets({ id });

	useEffect(() => {
		updateButtons({
			mainButton: {
				state: "visible",
				text: "Collections",
				action: { type: "navigate", payload: "/collections" },
			},
			secondaryButton: { state: "hidden" },
		});
		return () =>
			updateButtons({
				mainButton: { state: "hidden" },
				secondaryButton: { state: "hidden" },
			});
	}, [updateButtons]);

	const infiniteLoader = useInfiniteLoader(
		async () => {
			if (hasNextPage && !isFetchingNextPage) await fetchNextPage();
		},
		{
			isItemLoaded: (index, items) => !!items[index],
			minimumBatchSize: 30,
			threshold: 5,
		},
	);

	const renderItem = useCallback(
		({ data, width }: { data: TweetData; width: number }) => (
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
		),
		[],
	);

	if (error) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<div className="text-center">
					<h2 className="font-semibold text-gray-900 text-xl">
						Failed to load collection
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
			{!isLoading && tweets.length === 0 && (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<h3 className="mb-2 font-medium text-gray-900 text-xl">
						No tweets in this collection
					</h3>
					<p className="max-w-md text-gray-600 text-sm">
						Add tweets to this collection to see them here.
					</p>
				</div>
			)}
			{tweets.length > 0 && (
				<div className="mx-auto max-w-7xl">
					<Masonry
						items={tweets}
						render={renderItem}
						columnGutter={16}
						onRender={infiniteLoader}
					/>
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute("/collections/$id")({
	component: CollectionDetail,
});

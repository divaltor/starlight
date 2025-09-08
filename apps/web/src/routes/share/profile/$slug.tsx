import { createFileRoute, useParams } from "@tanstack/react-router";
import { Filter } from "lucide-react";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback } from "react";
import { NotFound } from "@/components/not-found";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { useTweets } from "@/hooks/useTweets";

function SharedProfileViewer() {
	const { slug } = useParams({ from: "/share/profile/$slug" });

	const {
		tweets,
		isLoading,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	} = useTweets({ source: "shared-profile", slug, retry: false });

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

	if (error) {
		const isNotFound =
			error instanceof Error &&
			error.message.toLowerCase().includes("not found");

		if (isNotFound) {
			return (
				<NotFound
					title="Link is disabled (｡•́︿•̀｡)"
					description="This shared profile link is no longer available. It may have been revoked"
					primaryAction={{
						label: "Back to home",
						onClick: () => {
							window.location.href = "/app";
						},
					}}
				/>
			);
		}

		return (
			<NotFound
				title="Failed to load shared profile"
				description={
					error instanceof Error ? error.message : "An error occurred"
				}
				primaryAction={{
					label: "Go to App",
					onClick: () => {
						window.location.href = "/app";
					},
				}}
				secondaryAction={{
					label: "Retry",
					onClick: () => window.location.reload(),
				}}
			/>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 p-4">
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

			{!isLoading && tweets.length === 0 && (
				<div className="flex flex-col items-center justify-center py-16">
					<Filter className="mb-4 h-16 w-16 text-gray-400" />
					<h3 className="mb-2 font-medium text-gray-900 text-xl">
						No posts found
					</h3>
					<p className="max-w-md text-center text-gray-600">Try again later.</p>
				</div>
			)}

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

export const Route = createFileRoute("/share/profile/$slug")({
	component: SharedProfileViewer,
});

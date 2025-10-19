import type {
	TweetData,
	TweetsPageResult,
} from "@starlight/api/src/types/tweets";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Filter } from "lucide-react";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback } from "react";
import { NotFound } from "@/components/not-found";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { useTweets } from "@/hooks/use-tweets";
import { orpc } from "@/utils/orpc";

function SharedProfileViewer() {
	const { slug } = useParams({ from: "/profile/$slug" });

	const {
		tweets,
		isLoading,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	} = useTweets({ username: slug });

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

	if (error) {
		const isNotFound =
			error instanceof Error &&
			error.message.toLowerCase().includes("not found");

		if (isNotFound) {
			return (
				<NotFound
					description="This shared profile link is no longer available. It may have been revoked"
					primaryAction={{
						label: "Back to home",
						onClick: () => {
							window.location.href = "/app";
						},
					}}
					title="Link is disabled (｡•́︿•̀｡)"
				/>
			);
		}

		return (
			<NotFound
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
				title="Failed to load shared profile"
			/>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 p-4">
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

export const Route = createFileRoute("/profile/$slug")({
	loader: async ({ context: { queryClient }, params: { slug } }) => {
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
				queryKey: ["tweets", { username: slug }],
				initialPageParam: undefined,
				getNextPageParam: (lastPage: TweetsPageResult) =>
					lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
			})
		);
	},
	component: SharedProfileViewer,
});

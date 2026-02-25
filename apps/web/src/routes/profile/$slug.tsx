import type { TweetData, TweetsPageResult } from "@starlight/api/src/types/tweets";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback } from "react";
import { NotFound } from "@/components/not-found";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { useTweets } from "@/hooks/use-tweets";
import { orpc } from "@/utils/orpc";

function SharedProfileViewer() {
	const { slug } = useParams({ from: "/profile/$slug" });

	const { tweets, isLoading, isFetchingNextPage, hasNextPage, error, fetchNextPage } = useTweets({
		username: slug,
	});

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
		({ data, width }: { data: TweetData; width: number }) => (
			<div className="mb-1" style={{ width }}>
				<TweetImageGrid tweet={data} />
			</div>
		),
		[],
	);

	if (error) {
		return (
			<div className="h-screen bg-base-100 p-4">
				<NotFound
					description="Profile is private or no longer exists."
					primaryAction={{
						label: "Back to home",
						onClick: () => {
							window.location.href = "/app";
						},
					}}
					title="Cannot access the profile (｡•́︿•̀｡)"
				/>
			</div>
		);
	}

	return (
		<div className="flex min-h-screen flex-col bg-base-100 p-4">
			{!isLoading && tweets.length === 0 && (
				<div className="flex flex-1 items-center justify-center">
					<NotFound
						description="This user hasn't shared any posts yet. Try again later."
						title="No posts found"
					/>
				</div>
			)}

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
				getNextPageParam: (lastPage: TweetsPageResult) => lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
			}),
		);
	},
	component: SharedProfileViewer,
});

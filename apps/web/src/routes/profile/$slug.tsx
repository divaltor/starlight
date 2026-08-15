import type { PostData, PostsPageResult } from "@starlight/api/src/types/posts";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback, lazy, Suspense } from "react";
import { NotFound } from "@/components/not-found";
const PostMediaGrid = lazy(() => import("@/components/post-media-grid").then((m) => ({ default: m.PostMediaGrid })));
import { usePosts } from "@/hooks/use-posts";
import { orpc } from "@/utils/orpc";

const MASONRY_ITEM_HEIGHT_ESTIMATE = 360;
const MASONRY_OVERSCAN_BY = 1.25;

function SharedProfileViewer() {
	const { slug } = useParams({ from: "/profile/$slug" });

	const { posts, isLoading, isFetchingNextPage, hasNextPage, error, fetchNextPage } = usePosts({
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
		({ data, width }: { data: PostData; width: number }) => (
			<div className="mb-1" style={{ width }}>
				<PostMediaGrid post={data} />
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
			{!isLoading && posts.length === 0 && (
				<div className="flex flex-1 items-center justify-center">
					<NotFound
						description="This user hasn't shared any posts yet. Try again later."
						title="No posts found"
					/>
				</div>
			)}

			{posts.length > 0 && (
				<div className="flex-1">
					<div className="mx-auto max-w-7xl">
					<Suspense fallback={null}>
						<Masonry
							columnGutter={16}
							itemHeightEstimate={MASONRY_ITEM_HEIGHT_ESTIMATE}
							itemKey={(post) => post.id}
							items={posts}
							onRender={infiniteLoader}
							overscanBy={MASONRY_OVERSCAN_BY}
							render={renderMasonryItem}
						/>
					</Suspense>
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
			orpc.posts.list.infiniteOptions({
				input: (pageParam: string | undefined) => ({
					cursor: pageParam,
					limit: 30,
				}),
				queryKey: ["posts", { username: slug }],
				initialPageParam: undefined,
				getNextPageParam: (lastPage: PostsPageResult) => lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
			}),
		);
	},
	component: SharedProfileViewer,
});

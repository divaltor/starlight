import type { ProfileResult } from "@starlight/api/routers/index";
import type { TweetData, TweetsPageResult } from "@starlight/api/types/tweets";
import { useQuery } from "@tanstack/react-query";
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
	const { updateButtons, rawInitData } = useTelegramContext();
	const router = useRouter();

	const { data: profile } = useQuery<ProfileResult>(
		orpc.profiles.get.queryOptions({
			queryKey: ["profile"],
			enabled: !!rawInitData,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: 1,
		})
	);

	useEffect(() => {
		if (!profile?.hasValidCookies) {
			updateButtons({
				mainButton: {
					state: "visible" as const,
					text: "Setup cookies" as const,
					color: "#ffd6a7" as const,
					textColor: "#9f2d00" as const,
					action: {
						type: "navigate" as const,
						payload: "/settings" as const,
					},
				},
			});
		} else if (profile.postingChannel) {
			updateButtons({
				mainButton: {
					state: "visible" as const,
					text: "Publications" as const,
					color: "#ffd6a7" as const,
					textColor: "#9f2d00" as const,
					action: {
						type: "navigate" as const,
						payload: "/publications" as const,
					},
				},
			});
		} else {
			updateButtons({
				mainButton: { state: "hidden" as const },
			});
		}

		return () => {
			updateButtons({
				mainButton: { state: "hidden" },
				secondaryButton: { state: "hidden" },
			});
		};
	}, [updateButtons, profile]);

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

		const profileOptions = orpc.profiles.get.queryOptions({
			queryKey: ["profile"],
			enabled: true,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: 1,
		});

		await queryClient.fetchQuery(profileOptions);

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

import type { ProfileResult } from "@starlight/api/routers/index";
import type { TweetData, TweetsPageResult } from "@starlight/api/types/tweets";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Search } from "lucide-react";
import { Masonry, useInfiniteLoader } from "masonic";
import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useEffect, useState } from "react";
import NotFound from "@/components/not-found";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSearch } from "@/hooks/use-search";
import { useTweets } from "@/hooks/use-tweets";
import { cn } from "@/lib/utils";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { orpc } from "@/utils/orpc";

function TwitterArtViewer() {
	const { updateButtons, rawInitData } = useTelegramContext();

	// Search state with URL params and history support
	const [urlQuery, setUrlQuery] = useQueryState(
		"q",
		parseAsString.withDefault("")
	);
	const [inputValue, setInputValue] = useState(urlQuery);

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
		if (profile && !profile.hasValidCookies) {
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
		}

		return () => {
			updateButtons({
				mainButton: { state: "hidden" },
				secondaryButton: { state: "hidden" },
			});
		};
	}, [updateButtons, profile]);

	// Search hook - search only own tweets in TMA
	const {
		results: searchResults,
		isLoading: isSearchLoading,
		isFetchingNextPage: isSearchFetchingNextPage,
		hasNextPage: hasSearchNextPage,
		fetchNextPage: fetchSearchNextPage,
	} = useSearch({ query: urlQuery, ownOnly: true });

	const isSearchActive = urlQuery.trim().length > 0;

	const {
		tweets,
		isLoading,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	} = useTweets();

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmedQuery = inputValue.trim();
		setUrlQuery(trimmedQuery || null, { history: "push" });
	};

	// Infinite loader for regular tweets
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

	// Infinite loader for search results
	const searchInfiniteLoader = useInfiniteLoader(
		async (_startIndex: number, _stopIndex: number, _items: any[]) => {
			if (hasSearchNextPage && !isSearchFetchingNextPage) {
				await fetchSearchNextPage();
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

	// Determine which data to display
	const displayItems = isSearchActive ? searchResults : tweets;
	const displayLoading = isSearchActive ? isSearchLoading : isLoading;
	const currentInfiniteLoader = isSearchActive
		? searchInfiniteLoader
		: infiniteLoader;

	return (
		<div className="flex min-h-screen flex-col p-4">
			{/* Loading State */}
			{displayLoading && (
				<div className="flex flex-1 items-center justify-center">
					{/** biome-ignore lint/correctness/useImageSize: animated loader GIF uses CSS sizing intentionally */}
					<img
						alt="Searching for cute anime girls..."
						className="mx-auto h-auto w-64"
						src="/suisei-hq.gif"
					/>
				</div>
			)}

			{!displayLoading && displayItems.length === 0 && (
				<div className="flex flex-1 items-center justify-center">
					<NotFound
						description={
							isSearchActive
								? "No results found for your search. Try different keywords."
								: "Did you setup cookies? Try again later."
						}
						title={isSearchActive ? "No search results" : "No photos found"}
					/>
				</div>
			)}

			{/* Masonry Grid */}
			{displayItems.length > 0 && (
				<div className="flex-1">
					<div className="mx-auto max-w-7xl">
						<Masonry
							columnGutter={16}
							items={displayItems}
							onRender={currentInfiniteLoader}
							render={renderMasonryItem}
						/>
					</div>
				</div>
			)}

			{/* Sticky Search Bar at Bottom */}
			<div className="sticky bottom-0 z-10 py-4">
				<div className="mx-auto max-w-lg">
					<form className="form-control" onSubmit={handleSearch}>
						<div className="join w-full">
							<Input
								className="input input-bordered join-item flex-1"
								onChange={(e) => setInputValue(e.target.value)}
								placeholder="Search for images..."
								type="text"
								value={inputValue}
							/>
							<Button
								className={cn(
									"btn btn-primary join-item",
									displayLoading && "btn-disabled"
								)}
								disabled={displayLoading}
								type="submit"
							>
								{displayLoading ? (
									<span className="loading loading-spinner h-4 w-4" />
								) : (
									<Search className="h-4 w-4" />
								)}
								<span className="hidden sm:inline">Search</span>
							</Button>
						</div>
					</form>
				</div>
			</div>
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

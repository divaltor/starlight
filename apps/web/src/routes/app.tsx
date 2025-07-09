import { createFileRoute } from "@tanstack/react-router";
import { Calendar, Check, Filter, RefreshCw } from "lucide-react";
import { Masonry, useInfiniteLoader } from "masonic";
import { useCallback, useEffect, useState } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useTweets } from "@/hooks/useTweets";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import type { DateFilter } from "@/types/dates";

function TwitterArtViewer() {
	const [dateFilter, setDateFilter] = useState<DateFilter>("all");
	const [isFilterActive, setIsFilterActive] = useState(false);

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
	} = useTweets({ dateFilter });

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

	// Update filter active state
	useEffect(() => {
		setIsFilterActive(dateFilter !== "all");
	}, [dateFilter]);

	// Reset filters
	const resetFilters = useCallback(() => {
		setDateFilter("all");
	}, []);

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
		<div className="bg-gray-50 p-4">
			{/* Header with Filters */}
			<div className="mx-auto mb-8 max-w-7xl">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h1 className="font-bold text-3xl text-gray-900">
							Twitter Art Gallery
						</h1>
					</div>

					<div className="flex gap-2">
						{/* Date Filter */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" className="gap-2">
									<Calendar className="h-4 w-4" />
									{dateFilter === "all"
										? "All Time"
										: dateFilter === "today"
											? "Today"
											: dateFilter === "week"
												? "This Week"
												: "This Year"}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-56">
								<DropdownMenuLabel>Filter by Date</DropdownMenuLabel>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									{[
										{ value: "all", label: "All Time" },
										{ value: "today", label: "Today" },
										{ value: "week", label: "This Week" },
										{ value: "year", label: "This Year" },
									].map((option) => (
										<DropdownMenuItem
											key={option.value}
											onClick={() => setDateFilter(option.value as DateFilter)}
										>
											<Check
												className={`mr-2 h-4 w-4 ${
													dateFilter === option.value
														? "opacity-100"
														: "opacity-0"
												}`}
											/>
											{option.label}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>

						{/* Reset Filters */}
						{isFilterActive && (
							<Button
								variant="outline"
								onClick={resetFilters}
								className="gap-2"
							>
								<RefreshCw className="h-4 w-4" />
								Reset
							</Button>
						)}
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
					<Button variant="outline" className="mt-6" onClick={resetFilters}>
						Reset Filters
					</Button>
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
						scrollFps={4}
					/>
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute("/app")({
	component: TwitterArtViewer,
});

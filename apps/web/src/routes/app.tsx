import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import {
	Calendar,
	Check,
	ChevronLeft,
	ChevronRight,
	Filter,
	Loader2,
	RefreshCw,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type DateFilter =
	| "all"
	| "today"
	| "week"
	| "month"
	| "3months"
	| "6months"
	| "year";

function TwitterArtViewer() {
	const [selectedImage, setSelectedImage] = useState<number | null>(null);
	const [isImageLoading, setIsImageLoading] = useState<{
		[key: string]: boolean;
	}>({});
	const [dateFilter, setDateFilter] = useState<DateFilter>("all");
	const [isFilterActive, setIsFilterActive] = useState(false);

	const {
		tweets,
		tweetMap,
		loadMoreRef,
		isLoading,
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
	} = useTweets({
		dateFilter,
	});

	// Server-side filtering eliminates the need for client-side processing
	// tweets are already filtered by the server based on dateFilter
	const filteredTweets = tweets;

	// Calculate total photos count - O(1) space, O(n) time but only when needed
	const totalPhotosCount = useMemo(() => {
		return filteredTweets.reduce((sum, tweet) => sum + tweet.photoCount, 0);
	}, [filteredTweets]);

	// Update filter active state
	useEffect(() => {
		setIsFilterActive(dateFilter !== "all");
	}, [dateFilter]);

	// Reset filters
	const resetFilters = useCallback(() => {
		setDateFilter("all");
	}, []);

	// O(1) space complexity helper functions
	const getPhotoByGlobalIndex = useCallback(
		(globalIndex: number) => {
			if (globalIndex < 0 || globalIndex >= totalPhotosCount) return null;

			let currentIndex = 0;
			for (const tweet of filteredTweets) {
				if (globalIndex < currentIndex + tweet.photoCount) {
					const photoIndex = globalIndex - currentIndex;
					const photo = tweet.photos[photoIndex];
					return {
						...photo,
						tweetId: tweet.id,
						artist: tweet.artist,
						date: tweet.date,
						tweetUrl: tweet.tweetUrl,
						photoIndex,
						totalPhotosInTweet: tweet.photoCount,
					};
				}
				currentIndex += tweet.photoCount;
			}
			return null;
		},
		[filteredTweets, totalPhotosCount],
	);

	const getTweetByGlobalIndex = useCallback(
		(globalIndex: number) => {
			if (globalIndex < 0 || globalIndex >= totalPhotosCount) return null;

			let currentIndex = 0;
			for (
				let tweetIndex = 0;
				tweetIndex < filteredTweets.length;
				tweetIndex++
			) {
				const tweet = filteredTweets[tweetIndex];
				if (globalIndex < currentIndex + tweet.photoCount) {
					return { ...tweet, index: tweetIndex };
				}
				currentIndex += tweet.photoCount;
			}
			return null;
		},
		[filteredTweets, totalPhotosCount],
	);

	const openImage = useCallback((imageIndex: number) => {
		setSelectedImage(imageIndex);
	}, []);

	const closeImage = useCallback(() => {
		setSelectedImage(null);
	}, []);

	const getTweetStartIndex = useCallback(
		(tweetIndex: number) => {
			if (tweetIndex < 0 || tweetIndex >= filteredTweets.length) return -1;

			let startIndex = 0;
			for (let i = 0; i < tweetIndex; i++) {
				startIndex += filteredTweets[i].photoCount;
			}
			return startIndex;
		},
		[filteredTweets],
	);

	const navigateImage = useCallback(
		(direction: "prev" | "next") => {
			if (selectedImage === null || totalPhotosCount === 0) return;

			const currentPhoto = getPhotoByGlobalIndex(selectedImage);
			const currentTweet = getTweetByGlobalIndex(selectedImage);

			if (!currentTweet || !currentPhoto) return;

			// Get current position within the tweet
			const currentPhotoIndexInTweet = currentPhoto.photoIndex;
			const totalPhotosInTweet = currentTweet.photoCount;

			if (direction === "next") {
				// If not the last image in the current tweet, go to next image in same tweet
				if (currentPhotoIndexInTweet < totalPhotosInTweet - 1) {
					setSelectedImage(selectedImage + 1);
				} else {
					// Move to first image of next tweet
					const currentTweetIndex = currentTweet.index;
					const nextTweetIndex =
						currentTweetIndex < filteredTweets.length - 1
							? currentTweetIndex + 1
							: 0; // Wrap to first tweet

					const firstImageOfNextTweet = getTweetStartIndex(nextTweetIndex);
					setSelectedImage(firstImageOfNextTweet);
				}
			} else {
				// If not the first image in the current tweet, go to previous image in same tweet
				if (currentPhotoIndexInTweet > 0) {
					setSelectedImage(selectedImage - 1);
				} else {
					// Move to last image of previous tweet
					const currentTweetIndex = currentTweet.index;
					const prevTweetIndex =
						currentTweetIndex > 0
							? currentTweetIndex - 1
							: filteredTweets.length - 1; // Wrap to last tweet

					const prevTweet = filteredTweets[prevTweetIndex];
					const lastImageOfPrevTweet =
						getTweetStartIndex(prevTweetIndex) + prevTweet.photoCount - 1;
					setSelectedImage(lastImageOfPrevTweet);
				}
			}
		},
		[
			selectedImage,
			totalPhotosCount,
			getPhotoByGlobalIndex,
			getTweetByGlobalIndex,
			getTweetStartIndex,
			filteredTweets,
		],
	);

	const handleImageLoad = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: false }));
	}, []);

	const handleImageLoadStart = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: true }));
	}, []);

	// O(1) space complexity image index lookup
	const getImageIndex = useCallback(
		(tweetId: string, imageId: string) => {
			let currentIndex = 0;
			for (const tweet of filteredTweets) {
				if (tweet.id === tweetId) {
					const photoIndex = tweet.photos.findIndex(
						(photo) => photo.id === imageId,
					);
					return photoIndex !== -1 ? currentIndex + photoIndex : -1;
				}
				currentIndex += tweet.photoCount;
			}
			return -1;
		},
		[filteredTweets],
	);

	const formatDate = useCallback((dateString: string) => {
		const date = new Date(dateString);
		return format(date, "MMM d, yyyy");
	}, []);

	// Optimized image grid rendering with memoization
	const renderImageGrid = useCallback(
		(tweet: (typeof tweets)[0]) => {
			const photos = tweet.photos;

			if (photos.length === 1) {
				const photo = photos[0];
				const imageIndex = getImageIndex(tweet.id, photo.id);

				return (
					<div
						className="group relative cursor-pointer overflow-hidden rounded-lg bg-gray-100 shadow-sm transition-shadow duration-300 hover:shadow-md"
						onClick={() => openImage(imageIndex)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								openImage(imageIndex);
							}
						}}
						tabIndex={0}
						role="button"
						aria-label={`View image by ${tweet.artist}`}
					>
						{isImageLoading[photo.id] && (
							<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
								<div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
							</div>
						)}
						<img
							src={photo.url || "/placeholder.svg"}
							alt={photo.alt}
							width={400}
							height={400}
							className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
							onLoadStart={() => handleImageLoadStart(photo.id)}
							onLoad={() => handleImageLoad(photo.id)}
						/>
						<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent">
							<div className="p-3 text-white">
								<p className="font-medium text-sm drop-shadow-lg">
									{tweet.artist}
								</p>
								<p className="text-gray-200 text-xs drop-shadow-lg">
									{formatDate(tweet.date)}
								</p>
							</div>
						</div>
					</div>
				);
			}

			// Multiple images layout with responsive grid
			return (
				<div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow duration-300 hover:shadow-md">
					{/* Post header */}
					<div className="mb-3 flex items-center justify-between">
						<div>
							<p className="font-medium text-gray-900 text-sm">
								{tweet.artist}
							</p>
							<p className="text-gray-500 text-xs">{formatDate(tweet.date)}</p>
						</div>
						<span className="text-gray-500 text-xs">
							{tweet.photoCount} images
						</span>
					</div>

					{/* Dynamic grid based on number of images */}
					{photos.length === 2 && (
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{photos.map((photo) => {
								const imageIndex = getImageIndex(tweet.id, photo.id);

								return (
									<div
										key={photo.id}
										className="group relative cursor-pointer overflow-hidden rounded bg-gray-100"
										onClick={() => openImage(imageIndex)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												openImage(imageIndex);
											}
										}}
										tabIndex={0}
										role="button"
										aria-label={`View image ${photo.id}`}
									>
										{isImageLoading[photo.id] && (
											<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
												<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
											</div>
										)}
										<img
											src={photo.url || "/placeholder.svg"}
											alt={photo.alt}
											width={400}
											height={400}
											className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
											onLoadStart={() => handleImageLoadStart(photo.id)}
											onLoad={() => handleImageLoad(photo.id)}
										/>
										<div className="absolute inset-0 bg-opacity-0 transition-all duration-300 group-hover:bg-opacity-20" />
									</div>
								);
							})}
						</div>
					)}

					{photos.length === 3 && (
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{photos.map((photo, index) => {
								const imageIndex = getImageIndex(tweet.id, photo.id);

								return (
									<div
										key={photo.id}
										className={`group relative cursor-pointer overflow-hidden rounded bg-gray-100 ${
											index === 0 ? "sm:col-span-2" : ""
										}`}
										onClick={() => openImage(imageIndex)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												openImage(imageIndex);
											}
										}}
										tabIndex={0}
										role="button"
										aria-label={`View image ${photo.id}`}
									>
										{isImageLoading[photo.id] && (
											<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
												<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
											</div>
										)}
										<img
											src={photo.url || "/placeholder.svg"}
											alt={photo.alt}
											width={400}
											height={400}
											className={`w-full transition-transform duration-300 group-hover:scale-105 ${
												index === 0 ? "h-auto" : "h-auto"
											}`}
											onLoadStart={() => handleImageLoadStart(photo.id)}
											onLoad={() => handleImageLoad(photo.id)}
										/>
										<div className="absolute inset-0 bg-opacity-0 transition-all duration-300 group-hover:bg-opacity-20" />
									</div>
								);
							})}
						</div>
					)}

					{photos.length === 4 && (
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{photos.map((photo) => {
								const imageIndex = getImageIndex(tweet.id, photo.id);

								return (
									<div
										key={photo.id}
										className="group relative cursor-pointer overflow-hidden rounded bg-gray-100"
										onClick={() => openImage(imageIndex)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												openImage(imageIndex);
											}
										}}
										tabIndex={0}
										role="button"
										aria-label={`View image ${photo.id}`}
									>
										{isImageLoading[photo.id] && (
											<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
												<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
											</div>
										)}
										<img
											src={photo.url || "/placeholder.svg"}
											alt={photo.alt}
											width={400}
											height={400}
											className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
											onLoadStart={() => handleImageLoadStart(photo.id)}
											onLoad={() => handleImageLoad(photo.id)}
										/>
										<div className="absolute inset-0 bg-opacity-0 transition-all duration-300 group-hover:bg-opacity-20" />
									</div>
								);
							})}
						</div>
					)}

					{photos.length > 4 && (
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
							{photos.slice(0, 6).map((photo, index) => {
								const imageIndex = getImageIndex(tweet.id, photo.id);
								const isLastVisible = index === 5 && photos.length > 6;

								return (
									<div
										key={photo.id}
										className="group relative cursor-pointer overflow-hidden rounded bg-gray-100"
										onClick={() => openImage(imageIndex)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												openImage(imageIndex);
											}
										}}
										tabIndex={0}
										role="button"
										aria-label={`View image ${photo.id}`}
									>
										{isImageLoading[photo.id] && (
											<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
												<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
											</div>
										)}
										<img
											src={photo.url || "/placeholder.svg"}
											alt={photo.alt}
											width={400}
											height={400}
											className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
											onLoadStart={() => handleImageLoadStart(photo.id)}
											onLoad={() => handleImageLoad(photo.id)}
										/>
										{isLastVisible && (
											<div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
												<span className="font-medium text-lg">
													+{photos.length - 6}
												</span>
											</div>
										)}
										<div className="absolute inset-0 bg-opacity-0 transition-all duration-300 group-hover:bg-opacity-20" />
									</div>
								);
							})}
						</div>
					)}
				</div>
			);
		},
		[
			getImageIndex,
			formatDate,
			openImage,
			handleImageLoadStart,
			handleImageLoad,
			isImageLoading,
		],
	);

	// Keyboard navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (selectedImage === null) return;

			switch (e.key) {
				case "ArrowLeft":
					e.preventDefault();
					navigateImage("prev");
					break;
				case "ArrowRight":
					e.preventDefault();
					navigateImage("next");
					break;
				case "Escape":
					e.preventDefault();
					closeImage();
					break;
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [selectedImage, navigateImage, closeImage]);

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
												: dateFilter === "month"
													? "This Month"
													: dateFilter === "3months"
														? "Last 3 Months"
														: dateFilter === "6months"
															? "Last 6 Months"
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
										{ value: "month", label: "This Month" },
										{ value: "3months", label: "Last 3 Months" },
										{ value: "6months", label: "Last 6 Months" },
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
					<div className="masonry-grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
						{Array.from({ length: 12 }).map((_, i) => (
							<Skeleton
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
			{!isLoading && filteredTweets.length === 0 && (
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

			{/* Responsive Grid */}
			{filteredTweets.length > 0 && (
				<div className="mx-auto max-w-7xl">
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
						{filteredTweets.map((tweet, index) => (
							<div
								key={tweet.id}
								data-tweet-index={index}
								data-tweet-id={tweet.id}
								className="will-change-auto"
							>
								{renderImageGrid(tweet)}
							</div>
						))}
					</div>

					{/* Infinite Scroll Trigger - Fixed positioning to prevent shifts */}
					<div className="mt-8 flex min-h-[60px] items-center justify-center">
						{hasNextPage ? (
							<div ref={loadMoreRef}>
								{isFetchingNextPage ? (
									<div className="flex items-center gap-2 text-gray-600">
										<Loader2 className="h-5 w-5 animate-spin" />
										Loading more images...
									</div>
								) : (
									<div className="text-gray-500">Scroll to load more</div>
								)}
							</div>
						) : !isFetching ? (
							<div className="text-center text-gray-500">
								You've reached the end! 🎉
							</div>
						) : null}
					</div>
				</div>
			)}

			{/* Full Screen Image Modal */}
			<Dialog open={selectedImage !== null} onOpenChange={closeImage}>
				<DialogContent className="max-h-[95vh] max-w-[95vw] border-0 bg-white p-0">
					{selectedImage !== null &&
						selectedImage < totalPhotosCount &&
						(() => {
							const currentPhoto = getPhotoByGlobalIndex(selectedImage);
							const currentTweet = getTweetByGlobalIndex(selectedImage);

							if (!currentPhoto || !currentTweet) return null;

							return (
								<div className="relative flex h-full w-full items-center justify-center">
									{/* Close Button */}
									<Button
										variant="secondary"
										size="icon"
										className="absolute top-4 right-4 z-10 border border-white/20 bg-black/50 text-white shadow-2xl backdrop-blur-lg hover:bg-black/70 hover:shadow-3xl"
										onClick={closeImage}
									>
										<X className="h-6 w-6" />
									</Button>

									{/* Navigation Buttons */}
									<Button
										variant="secondary"
										size="icon"
										className="-translate-y-1/2 absolute top-1/2 left-4 z-10 border border-white/20 bg-black/50 text-white shadow-2xl backdrop-blur-lg hover:bg-black/70 hover:shadow-3xl"
										onClick={() => navigateImage("prev")}
									>
										<ChevronLeft className="h-8 w-8" />
									</Button>

									<Button
										variant="secondary"
										size="icon"
										className="-translate-y-1/2 absolute top-1/2 right-4 z-10 border border-white/20 bg-black/50 text-white shadow-2xl backdrop-blur-lg hover:bg-black/70 hover:shadow-3xl"
										onClick={() => navigateImage("next")}
									>
										<ChevronRight className="h-8 w-8" />
									</Button>

									{/* Main Image */}
									<div className="flex max-h-full max-w-full flex-col items-center p-8">
										<img
											src={currentPhoto.url || "/placeholder.svg"}
											alt={currentPhoto.alt}
											width={800}
											height={800}
											className="h-auto max-h-[65vh] w-auto max-w-full object-contain"
										/>

										{/* Thumbnail Navigation for Multi-Image Tweets */}
										{currentTweet.isMultiImage && (
											<div className="mt-4 max-w-[90vw] overflow-x-auto">
												<div className="flex gap-2 rounded-lg border border-gray-200 bg-white/90 p-2 backdrop-blur-sm">
													{currentTweet.photos.map((tweetPhoto, index) => {
														const imageIndex = getImageIndex(
															currentTweet.id,
															tweetPhoto.id,
														);
														const isActive = tweetPhoto.id === currentPhoto.id;

														return (
															<button
																key={tweetPhoto.id}
																type="button"
																className={`relative cursor-pointer transition-all duration-200 ${
																	isActive
																		? "scale-110 ring-2 ring-blue-500 ring-offset-2 ring-offset-white"
																		: "opacity-70 hover:scale-105 hover:opacity-100"
																}`}
																onClick={() => setSelectedImage(imageIndex)}
																aria-label={`View image ${index + 1} of ${currentTweet.photoCount}`}
															>
																<img
																	src={tweetPhoto.url || "/placeholder.svg"}
																	alt={tweetPhoto.alt}
																	width={400}
																	height={400}
																	className="h-16 w-16 rounded object-cover"
																/>
																{isActive && (
																	<div className="absolute inset-0 rounded bg-blue-500/20" />
																)}
															</button>
														);
													})}
												</div>
											</div>
										)}

										{/* Image Counter */}
										<div className="my-4 rounded-full border border-white/20 bg-black/50 px-3 py-1 text-sm text-white shadow-2xl backdrop-blur-lg">
											{selectedImage + 1} / {totalPhotosCount}
										</div>

										{/* Image Info Card */}
										<div className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-6 text-gray-900 shadow-lg">
											<div className="flex items-start justify-between">
												<div>
													<a
														href={currentPhoto.tweetUrl}
														target="_blank"
														rel="noopener noreferrer"
														className="font-medium text-gray-900 transition-colors hover:text-blue-600"
														title="View original tweet"
													>
														{currentPhoto.artist}
													</a>
													<p className="text-gray-600 text-sm">
														{formatDate(currentPhoto.date)}
													</p>
												</div>
											</div>

											<p className="mt-3 text-gray-500 text-sm">
												← → Navigate between images
											</p>
										</div>
									</div>
								</div>
							);
						})()}
				</DialogContent>
			</Dialog>
		</div>
	);
}

export const Route = createFileRoute("/app")({
	component: TwitterArtViewer,
});

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
	User,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface PhotoData {
	id: string;
	url: string;
	alt: string;
}

interface TweetData {
	id: string;
	tweetUrl: string;
	artist: string;
	date: string;
	photos: PhotoData[];
}

// Date filter options
type DateFilter =
	| "all"
	| "today"
	| "week"
	| "month"
	| "3months"
	| "6months"
	| "year";

function TwitterArtViewer() {
	// Fetch real data from database
	const { data: tweets = [], isLoading: queryLoading, error } = useTweets();
	const [isLoading, setIsLoading] = useState(true);

	const [selectedImage, setSelectedImage] = useState<number | null>(null);
	const [isImageLoading, setIsImageLoading] = useState<{
		[key: string]: boolean;
	}>({});
	const [selectedArtist, setSelectedArtist] = useState<string | null>(null);
	const [dateFilter, setDateFilter] = useState<DateFilter>("all");
	const [isFilterActive, setIsFilterActive] = useState(false);

	// Get unique artists from the real data
	const uniqueArtists = useMemo(() => {
		const artists = new Set<string>();
		for (const tweet of tweets) {
			artists.add(tweet.artist);
		}
		return Array.from(artists).sort();
	}, [tweets]);

	// Apply filters to get filtered tweets
	const filteredTweets = useMemo(() => {
		let filtered = [...tweets];

		// Filter by artist
		if (selectedArtist) {
			filtered = filtered.filter((tweet) => tweet.artist === selectedArtist);
		}

		// Filter by date
		if (dateFilter !== "all") {
			const now = new Date();
			const cutoffDate = new Date();

			switch (dateFilter) {
				case "today":
					cutoffDate.setHours(0, 0, 0, 0);
					break;
				case "week":
					cutoffDate.setDate(now.getDate() - 7);
					break;
				case "month":
					cutoffDate.setMonth(now.getMonth() - 1);
					break;
				case "3months":
					cutoffDate.setMonth(now.getMonth() - 3);
					break;
				case "6months":
					cutoffDate.setMonth(now.getMonth() - 6);
					break;
				case "year":
					cutoffDate.setFullYear(now.getFullYear() - 1);
					break;
			}

			filtered = filtered.filter((tweet) => new Date(tweet.date) >= cutoffDate);
		}

		return filtered;
	}, [tweets, selectedArtist, dateFilter]);

	// Create a flat list of all photos for navigation
	const allPhotos = useMemo(() => {
		const photos: Array<
			PhotoData & {
				tweetId: string;
				artist: string;
				date: string;
				tweetUrl: string;
			}
		> = [];
		for (const tweet of filteredTweets) {
			for (const photo of tweet.photos) {
				photos.push({
					...photo,
					tweetId: tweet.id,
					artist: tweet.artist,
					date: tweet.date,
					tweetUrl: tweet.tweetUrl,
				});
			}
		}
		return photos;
	}, [filteredTweets]);

	// Update loading state based on query status
	useEffect(() => {
		setIsLoading(queryLoading);
	}, [queryLoading]);

	// Update filter active state
	useEffect(() => {
		setIsFilterActive(selectedArtist !== null || dateFilter !== "all");
	}, [selectedArtist, dateFilter]);

	// Reset filters
	const resetFilters = () => {
		setSelectedArtist(null);
		setDateFilter("all");
	};

	// Helper functions for image navigation
	const getImageTweet = (imageIndex: number) => {
		const photo = allPhotos[imageIndex];
		return filteredTweets.find((tweet) => tweet.id === photo.tweetId);
	};

	const getTweetIndex = (imageIndex: number) => {
		const photo = allPhotos[imageIndex];
		return filteredTweets.findIndex((tweet) => tweet.id === photo.tweetId);
	};

	const getFirstImageOfTweet = (tweetIndex: number) => {
		if (tweetIndex < 0 || tweetIndex >= filteredTweets.length) return 0;
		const tweet = filteredTweets[tweetIndex];
		return allPhotos.findIndex((photo) => photo.tweetId === tweet.id);
	};

	const openImage = (imageIndex: number) => {
		setSelectedImage(imageIndex);
	};

	const closeImage = () => {
		setSelectedImage(null);
	};

	const navigateImage = (direction: "prev" | "next") => {
		if (selectedImage === null) return;

		const currentTweet = getImageTweet(selectedImage);
		const isMultiImage = currentTweet && currentTweet.photos.length > 1;

		if (isMultiImage) {
			// Navigate by tweets for multi-image posts
			const currentTweetIndex = getTweetIndex(selectedImage);
			let nextTweetIndex: number;

			if (direction === "prev") {
				nextTweetIndex =
					currentTweetIndex > 0
						? currentTweetIndex - 1
						: filteredTweets.length - 1;
			} else {
				nextTweetIndex =
					currentTweetIndex < filteredTweets.length - 1
						? currentTweetIndex + 1
						: 0;
			}

			const firstImageOfNextTweet = getFirstImageOfTweet(nextTweetIndex);
			setSelectedImage(firstImageOfNextTweet);
		} else {
			// Navigate by individual images for single-image posts
			if (direction === "prev") {
				setSelectedImage(
					selectedImage > 0 ? selectedImage - 1 : allPhotos.length - 1,
				);
			} else {
				setSelectedImage(
					selectedImage < allPhotos.length - 1 ? selectedImage + 1 : 0,
				);
			}
		}
	};

	const handleImageLoad = (imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: false }));
	};

	const handleImageLoadStart = (imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: true }));
	};

	const getImageIndex = (tweetId: string, imageId: string) => {
		return allPhotos.findIndex((photo) => photo.id === imageId);
	};

	const getImageDimensions = (url: string) => {
		const match = url.match(/height=(\d+)&width=(\d+)/);
		if (match) {
			return {
				height: Number.parseInt(match[1]),
				width: Number.parseInt(match[2]),
			};
		}
		return { height: 400, width: 400 };
	};

	const formatDate = (dateString: string) => {
		const date = new Date(dateString);
		return format(date, "MMM d, yyyy");
	};

	const renderImageGrid = (tweet: TweetData) => {
		const photos = tweet.photos;

		if (photos.length === 1) {
			const photo = photos[0];
			const imageIndex = getImageIndex(tweet.id, photo.id);
			const dimensions = getImageDimensions(photo.url);

			return (
				<div
					className="group relative cursor-pointer break-inside-avoid overflow-hidden rounded-lg bg-gray-100 shadow-sm transition-shadow duration-300 hover:shadow-md"
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
						width={dimensions.width}
						height={dimensions.height}
						className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
						onLoadStart={() => handleImageLoadStart(photo.id)}
						onLoad={() => handleImageLoad(photo.id)}
					/>
					<div className="absolute inset-0 flex items-end bg-opacity-0 transition-all duration-300 group-hover:bg-opacity-20">
						<div className="p-3 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
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
			<div className="break-inside-avoid rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow duration-300 hover:shadow-md">
				{/* Post header */}
				<div className="mb-3 flex items-center justify-between">
					<div>
						<p className="font-medium text-gray-900 text-sm">{tweet.artist}</p>
						<p className="text-gray-500 text-xs">{formatDate(tweet.date)}</p>
					</div>
					<span className="text-gray-500 text-xs">{photos.length} images</span>
				</div>

				{/* Dynamic grid based on number of images */}
				{photos.length === 2 && (
					<div className="grid grid-cols-2 gap-2">
						{photos.map((photo) => {
							const imageIndex = getImageIndex(tweet.id, photo.id);
							const dimensions = getImageDimensions(photo.url);

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
										width={dimensions.width}
										height={dimensions.height}
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
					<div className="grid grid-cols-2 gap-2">
						{photos.map((photo, index) => {
							const imageIndex = getImageIndex(tweet.id, photo.id);
							const dimensions = getImageDimensions(photo.url);

							return (
								<div
									key={photo.id}
									className={`group relative cursor-pointer overflow-hidden rounded bg-gray-100 ${
										index === 0 ? "col-span-2" : ""
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
										width={dimensions.width}
										height={dimensions.height}
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
					<div className="grid grid-cols-2 gap-2">
						{photos.map((photo) => {
							const imageIndex = getImageIndex(tweet.id, photo.id);
							const dimensions = getImageDimensions(photo.url);

							return (
								<div
									key={photo.id}
									className="group relative aspect-square cursor-pointer overflow-hidden rounded bg-gray-100"
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
										width={dimensions.width}
										height={dimensions.height}
										className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
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
					<div className="grid grid-cols-2 gap-2">
						{photos.slice(0, 3).map((photo, index) => {
							const imageIndex = getImageIndex(tweet.id, photo.id);
							const dimensions = getImageDimensions(photo.url);

							return (
								<div
									key={photo.id}
									className={`group relative cursor-pointer overflow-hidden rounded bg-gray-100 ${
										index === 0 ? "col-span-2" : ""
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
										width={dimensions.width}
										height={dimensions.height}
										className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
										onLoadStart={() => handleImageLoadStart(photo.id)}
										onLoad={() => handleImageLoad(photo.id)}
									/>
									<div className="absolute inset-0 bg-opacity-0 transition-all duration-300 group-hover:bg-opacity-20" />
								</div>
							);
						})}
						{/* Show remaining count overlay on last visible image */}
						<div className="relative">
							<div
								className="group relative aspect-square cursor-pointer overflow-hidden rounded bg-gray-100"
								onClick={() => openImage(getImageIndex(tweet.id, photos[3].id))}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										openImage(getImageIndex(tweet.id, photos[3].id));
									}
								}}
								tabIndex={0}
								role="button"
								aria-label={`View remaining ${photos.length - 3} images`}
							>
								<img
									src={photos[3].url || "/placeholder.svg"}
									alt={photos[3].alt}
									width={200}
									height={200}
									className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
								/>
								<div className="absolute inset-0 flex items-center justify-center bg-opacity-60">
									<span className="font-bold text-lg text-white drop-shadow-lg">
										+{photos.length - 3}
									</span>
								</div>
							</div>
						</div>
					</div>
				)}
			</div>
		);
	};

	// Loading state
	if (isLoading) {
		return (
			<div className="min-h-screen bg-gray-50 p-4">
				{/* Filter Bar Skeleton */}
				<div className="-mx-4 sticky top-0 z-10 mb-6 border-gray-200 border-b bg-white/90 px-4 py-3 shadow-sm backdrop-blur-md">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<Skeleton className="h-7 w-48" />
						<div className="flex items-center gap-2">
							<Skeleton className="h-8 w-20" />
							<Skeleton className="h-8 w-16" />
							<Skeleton className="h-8 w-16" />
						</div>
					</div>
				</div>

				{/* Grid Skeleton */}
				<div className="columns-1 gap-4 space-y-4 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
					{Array.from({ length: 12 }).map((_, i) => (
						<div key={i} className="break-inside-avoid">
							<Skeleton className="h-64 w-full rounded-lg" />
						</div>
					))}
				</div>
			</div>
		);
	}

	// Error state
	if (error) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<div className="text-center">
					<div className="mb-4 inline-block rounded-full bg-red-800 p-4">
						<X size={32} className="text-red-200" />
					</div>
					<h3 className="mb-2 font-medium text-white text-xl">
						Failed to load tweets
					</h3>
					<p className="mb-6 max-w-md text-gray-400">
						{error instanceof Error ? error.message : "Something went wrong"}
					</p>
					<Button variant="outline" onClick={() => window.location.reload()}>
						Try Again
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 p-4">
			{/* Filter Bar */}
			<div className="-mx-4 sticky top-0 z-10 mb-6 border-gray-200 border-b bg-white/90 px-4 py-3 shadow-sm backdrop-blur-md">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="font-bold text-gray-900 text-xl">Your saved images</h1>

					<div className="flex items-center gap-2">
						{/* Artist Filter */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant={selectedArtist ? "default" : "outline"}
									size="sm"
									className="flex items-center gap-2"
								>
									<User size={16} />
									{selectedArtist || "Artist"}
									{selectedArtist && (
										<X size={14} className="ml-1 opacity-70" />
									)}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-56">
								<DropdownMenuLabel>Filter by Artist</DropdownMenuLabel>
								<DropdownMenuSeparator />
								<div className="max-h-[300px] overflow-y-auto">
									<DropdownMenuGroup>
										{uniqueArtists.map((artist) => (
											<DropdownMenuItem
												key={artist}
												onClick={() =>
													setSelectedArtist(
														artist === selectedArtist ? null : artist,
													)
												}
												className="flex items-center justify-between"
											>
												{artist}
												{artist === selectedArtist && <Check size={16} />}
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</div>
							</DropdownMenuContent>
						</DropdownMenu>

						{/* Date Filter */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant={dateFilter !== "all" ? "default" : "outline"}
									size="sm"
									className="flex items-center gap-2"
								>
									<Calendar size={16} />
									{dateFilter === "all"
										? "Date"
										: dateFilter === "today"
											? "Today"
											: dateFilter === "week"
												? "Past Week"
												: dateFilter === "month"
													? "Past Month"
													: dateFilter === "3months"
														? "Past 3 Months"
														: dateFilter === "6months"
															? "Past 6 Months"
															: "Past Year"}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuLabel>Filter by Date</DropdownMenuLabel>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									<DropdownMenuItem
										onClick={() => setDateFilter("all")}
										className="flex items-center justify-between"
									>
										All Time
										{dateFilter === "all" && <Check size={16} />}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setDateFilter("today")}
										className="flex items-center justify-between"
									>
										Today
										{dateFilter === "today" && <Check size={16} />}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setDateFilter("week")}
										className="flex items-center justify-between"
									>
										Past Week
										{dateFilter === "week" && <Check size={16} />}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setDateFilter("month")}
										className="flex items-center justify-between"
									>
										Past Month
										{dateFilter === "month" && <Check size={16} />}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setDateFilter("3months")}
										className="flex items-center justify-between"
									>
										Past 3 Months
										{dateFilter === "3months" && <Check size={16} />}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setDateFilter("6months")}
										className="flex items-center justify-between"
									>
										Past 6 Months
										{dateFilter === "6months" && <Check size={16} />}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setDateFilter("year")}
										className="flex items-center justify-between"
									>
										Past Year
										{dateFilter === "year" && <Check size={16} />}
									</DropdownMenuItem>
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>

						{/* Reset Filters */}
						{isFilterActive && (
							<Button
								variant="ghost"
								size="sm"
								onClick={resetFilters}
								className="flex items-center gap-2"
							>
								<RefreshCw size={16} />
								Reset
							</Button>
						)}
					</div>
				</div>

				{/* Filter Status */}
				{isFilterActive && (
					<div className="mt-2 text-gray-600 text-sm">
						Showing {filteredTweets.length}{" "}
						{filteredTweets.length === 1 ? "post" : "posts"}
						{selectedArtist && <span> by {selectedArtist}</span>}
						{dateFilter !== "all" && (
							<span>
								{" "}
								from{" "}
								{dateFilter === "today"
									? "today"
									: dateFilter === "week"
										? "the past week"
										: dateFilter === "month"
											? "the past month"
											: dateFilter === "3months"
												? "the past 3 months"
												: dateFilter === "6months"
													? "the past 6 months"
													: "the past year"}
							</span>
						)}
					</div>
				)}
			</div>

			{/* No Results Message */}
			{!isLoading && filteredTweets.length === 0 && (
				<div className="flex flex-col items-center justify-center py-20">
					<div className="mb-4 rounded-full bg-gray-100 p-4">
						<Filter size={32} className="text-gray-500" />
					</div>
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

			{/* Responsive Masonry Grid */}
			{filteredTweets.length > 0 && (
				<div className="columns-1 gap-4 space-y-4 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
					{filteredTweets.map((tweet) => (
						<div key={tweet.id}>{renderImageGrid(tweet)}</div>
					))}
				</div>
			)}

			{/* Full Screen Image Modal */}
			<Dialog open={selectedImage !== null} onOpenChange={closeImage}>
				<DialogContent className="max-h-[95vh] max-w-[95vw] border-0 bg-white p-0">
					{selectedImage !== null && (
						<div className="relative flex h-full w-full items-center justify-center">
							{/* Close Button */}
							<Button
								variant="ghost"
								size="icon"
								className="absolute top-4 right-4 z-10 text-gray-700 hover:bg-gray-100"
								onClick={closeImage}
							>
								<X className="h-6 w-6" />
							</Button>

							{/* Navigation Buttons */}
							<Button
								variant="ghost"
								size="icon"
								className="-translate-y-1/2 absolute top-1/2 left-4 z-10 text-gray-700 hover:bg-gray-100"
								onClick={() => navigateImage("prev")}
							>
								<ChevronLeft className="h-8 w-8" />
							</Button>

							<Button
								variant="ghost"
								size="icon"
								className="-translate-y-1/2 absolute top-1/2 right-4 z-10 text-gray-700 hover:bg-gray-100"
								onClick={() => navigateImage("next")}
							>
								<ChevronRight className="h-8 w-8" />
							</Button>

							{/* Main Image */}
							<div className="relative max-h-full max-w-full p-8">
								<img
									src={allPhotos[selectedImage].url || "/placeholder.svg"}
									alt={allPhotos[selectedImage].alt}
									width={800}
									height={800}
									className="h-auto max-h-[80vh] w-auto max-w-full object-contain"
								/>

								{/* Image Info */}
								<div className="absolute right-8 bottom-0 left-8 rounded-t-lg border border-gray-200 bg-white/90 p-4 text-gray-900 backdrop-blur-sm">
									<div className="flex items-start justify-between">
										<div>
											<p className="font-medium">
												{allPhotos[selectedImage].artist}
											</p>
											<p className="text-gray-600 text-sm">
												{formatDate(allPhotos[selectedImage].date)}
											</p>
											<a
												href={allPhotos[selectedImage].tweetUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="block text-blue-600 text-sm hover:text-blue-700"
											>
												View original tweet
											</a>
										</div>
									</div>
									{(() => {
										const currentTweet = getImageTweet(selectedImage);
										const isMultiImage =
											currentTweet && currentTweet.photos.length > 1;

										if (isMultiImage) {
											return (
												<p className="mt-2 text-gray-500 text-xs">
													← → Navigate between tweets • This tweet has{" "}
													{currentTweet.photos.length} images
												</p>
											);
										}
										return (
											<p className="mt-2 text-gray-500 text-xs">
												← → Navigate between images
											</p>
										);
									})()}
								</div>
							</div>

							{/* Thumbnail Navigation for Multi-Image Tweets */}
							{(() => {
								const currentTweet = getImageTweet(selectedImage);
								const isMultiImage =
									currentTweet && currentTweet.photos.length > 1;

								if (!isMultiImage) return null;

								const currentPhoto = allPhotos[selectedImage];

								return (
									<div className="-translate-x-1/2 absolute bottom-20 left-1/2 max-w-[90vw] overflow-x-auto">
										<div className="flex gap-2 rounded-lg border border-gray-200 bg-white/90 p-2 backdrop-blur-sm">
											{currentTweet.photos.map((tweetPhoto, index) => {
												const imageIndex = getImageIndex(
													currentTweet.id,
													tweetPhoto.id,
												);
												const dimensions = getImageDimensions(tweetPhoto.url);
												const isActive = tweetPhoto.id === currentPhoto.id;

												return (
													<div
														key={tweetPhoto.id}
														className={`relative cursor-pointer transition-all duration-200 ${
															isActive
																? "scale-110 ring-2 ring-blue-500 ring-offset-2 ring-offset-white"
																: "opacity-70 hover:scale-105 hover:opacity-100"
														}`}
														onClick={() => setSelectedImage(imageIndex)}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																setSelectedImage(imageIndex);
															}
														}}
														tabIndex={0}
														role="button"
														aria-label={`View image ${index + 1} of ${currentTweet.photos.length}`}
													>
														<img
															src={tweetPhoto.url || "/placeholder.svg"}
															alt={tweetPhoto.alt}
															width={dimensions.width}
															height={dimensions.height}
															className="h-16 w-16 rounded object-cover"
														/>
														{isActive && (
															<div className="absolute inset-0 rounded bg-blue-500/20" />
														)}
													</div>
												);
											})}
										</div>
									</div>
								);
							})()}

							{/* Image Counter */}
							<div
								className={`-translate-x-1/2 absolute bottom-4 left-1/2 rounded-full border border-gray-200 bg-white/90 px-3 py-1 text-gray-900 text-sm backdrop-blur-sm ${(() => {
									const currentTweet = getImageTweet(selectedImage);
									const isMultiImage =
										currentTweet && currentTweet.photos.length > 1;
									return isMultiImage ? "mb-20" : "";
								})()}`}
							>
								{(() => {
									const currentTweet = getImageTweet(selectedImage);
									const isMultiImage =
										currentTweet && currentTweet.photos.length > 1;

									if (isMultiImage) {
										const currentTweetIndex = getTweetIndex(selectedImage);
										const imageIndexInTweet = currentTweet.photos.findIndex(
											(photo) => photo.id === allPhotos[selectedImage].id,
										);
										return `Tweet ${currentTweetIndex + 1}/${filteredTweets.length} • Image ${imageIndexInTweet + 1}/${currentTweet.photos.length}`;
									}

									return `${selectedImage + 1} / ${allPhotos.length}`;
								})()}
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

export const Route = createFileRoute("/app")({
	component: TwitterArtViewer,
});

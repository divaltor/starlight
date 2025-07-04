import type { ScheduledSlotStatus } from "@repo/utils";
import { format } from "date-fns";
import {
	Calendar,
	MessageSquare,
	MoreVertical,
	Plus,
	Shuffle,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScheduledSlotWithTweets } from "@/routes/api/scheduled-slots";

interface SlotCardProps {
	id: string;
	scheduledFor: Date;
	status: ScheduledSlotStatus;
	scheduledSlotTweets: ScheduledSlotWithTweets;
	channelName?: string;
	onDelete?: (id: string) => void;
	onAddTweet?: (id: string) => void;
	onDeleteImage?: (id: string, photoId: string) => void;
	onShuffleTweet?: (id: string, tweetId: string) => void;
	className?: string;
}

export function SlotCard({
	id,
	scheduledFor,
	status,
	scheduledSlotTweets,
	channelName,
	onDelete,
	onAddTweet,
	onDeleteImage,
	onShuffleTweet,
	className = "",
}: SlotCardProps) {
	const [isMasonryReady, setIsMasonryReady] = useState(false);
	const [isImageLoading, setIsImageLoading] = useState<{
		[key: string]: boolean;
	}>({});
	const masonryGridRef = useRef<HTMLDivElement>(null);

	const formatDate = (date: Date) => {
		const today = new Date();
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate() + 1);

		const isToday = date.toDateString() === today.toDateString();
		const isTomorrow = date.toDateString() === tomorrow.toDateString();

		if (isToday) return "Today";
		if (isTomorrow) return "Tomorrow";

		return new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
		}).format(date);
	};

	const formatTweetDate = useCallback((dateString: string) => {
		const date = new Date(dateString);
		return format(date, "MMM d, yyyy");
	}, []);

	const getStatusVariant = (status: string) => {
		switch (status.toLowerCase()) {
			case "waiting":
				return "waiting" as const;
			case "published":
				return "published" as const;
			case "done":
				return "done" as const;
			default:
				return "outline" as const;
		}
	};

	const totalPhotos = scheduledSlotTweets.reduce(
		(sum, tweet) => sum + tweet.scheduledSlotPhotos.length,
		0,
	);

	const uniqueAuthors = [
		...new Set(
			scheduledSlotTweets.map(
				(tweet) => tweet.tweet.tweetData?.username || "unknown",
			),
		),
	];

	const canAddMoreTweets =
		scheduledSlotTweets.length < 10 && status === "WAITING";

	// Transform scheduled slot tweets to match the app.tsx structure
	const tweetsForDisplay = scheduledSlotTweets.map((slotTweet) => ({
		id: slotTweet.tweet.id,
		artist: slotTweet.tweet.tweetData?.username || "unknown",
		date: slotTweet.tweet.tweetData?.timeParsed || "",
		photoCount: slotTweet.scheduledSlotPhotos.length,
		photos: slotTweet.scheduledSlotPhotos
			.filter((sp) => sp.photo.s3Url)
			.map((sp) => ({
				id: sp.photo.id,
				url: sp.photo.s3Url,
				alt: `Photo by ${slotTweet.tweet.tweetData?.username || "unknown"}`,
			})),
		slotTweetId: slotTweet.id,
	}));

	const handleImageLoad = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: false }));
	}, []);

	const handleImageLoadStart = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: true }));
	}, []);

	// JavaScript masonry layout for browsers without masonry support
	const layoutMasonry = useCallback(() => {
		const grid = masonryGridRef.current;
		if (!grid) return;

		// Check if masonry is supported
		const supportsGridMasonry = CSS.supports("grid-template-rows", "masonry");
		if (supportsGridMasonry) {
			setIsMasonryReady(true);
			return;
		}

		const items = Array.from(grid.children) as HTMLElement[];
		if (items.length === 0) return;

		// Get grid gap and calculate number of columns based on viewport width
		let columns = 1;
		let gap = 16; // 1rem = 16px for single column
		const width = window.innerWidth;

		if (width >= 1536) {
			columns = 6;
			gap = 13.33; // 0.833rem
		} else if (width >= 1280) {
			columns = 5;
			gap = 12.8; // 0.8rem
		} else if (width >= 1024) {
			columns = 4;
			gap = 12; // 0.75rem
		} else if (width >= 768) {
			columns = 3;
			gap = 10.67; // 0.667rem
		} else if (width >= 640) {
			columns = 2;
			gap = 8; // 0.5rem
		}

		// Calculate column width
		const gridWidth = grid.offsetWidth;
		const columnWidth = (gridWidth - gap * (columns - 1)) / columns;

		// Initialize column heights array
		const columnHeights = new Array(columns).fill(0);

		// Position each item
		items.forEach((item) => {
			// Find the shortest column
			const shortestColumnIndex = columnHeights.indexOf(
				Math.min(...columnHeights),
			);

			// Calculate position
			const x = shortestColumnIndex * (columnWidth + gap);
			const y = columnHeights[shortestColumnIndex];

			// Position the item
			item.style.left = `${x}px`;
			item.style.top = `${y}px`;
			item.style.width = `${columnWidth}px`;

			// Update column height
			columnHeights[shortestColumnIndex] += item.offsetHeight + gap;
		});

		// Set container height
		const maxHeight = Math.max(...columnHeights);
		grid.style.height = `${maxHeight}px`;

		// Show the grid after layout is complete
		setIsMasonryReady(true);
	}, []);

	// Trigger layout on data changes and window resize  
	useEffect(() => {
		setIsMasonryReady(false);
		const timeoutId = setTimeout(layoutMasonry, 100);
		return () => clearTimeout(timeoutId);
	}, [layoutMasonry, totalPhotos, scheduledSlotTweets.length]);

	useEffect(() => {
		const handleResize = () => {
			setIsMasonryReady(false);
			layoutMasonry();
		};

		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [layoutMasonry]);

	// Re-layout when images load
	const handleImageLoadWithLayout = useCallback(
		(imageId: string) => {
			handleImageLoad(imageId);
			setTimeout(layoutMasonry, 50);
		},
		[handleImageLoad, layoutMasonry],
	);

	// Render image grid based on tweet structure (similar to app.tsx)
	const renderTweetImages = useCallback(
		(tweet: (typeof tweetsForDisplay)[0]) => {
			const photos = tweet.photos;

			if (photos.length === 1) {
				const photo = photos[0];

				return (
					<div
						key={tweet.id}
						className="group relative cursor-pointer overflow-hidden rounded-lg bg-gray-100 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md"
					>
						{isImageLoading[photo.id] && (
							<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
								<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
							</div>
						)}
						<img
							src={photo.url}
							alt={photo.alt}
							width={400}
							height={400}
							className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
							onLoadStart={() => handleImageLoadStart(photo.id)}
							onLoad={() => handleImageLoadWithLayout(photo.id)}
						/>
						<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
						<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent">
							<div className="w-full p-3 text-white">
								<div className="flex items-center justify-between">
									<div>
										<p className="font-medium text-sm drop-shadow-lg">
											{tweet.artist}
										</p>
										{tweet.date && (
											<p className="text-gray-200 text-xs drop-shadow-lg">
												{formatTweetDate(
													typeof tweet.date === "string"
														? tweet.date
														: tweet.date.toISOString(),
												)}
											</p>
										)}
									</div>
									{status === "WAITING" && (
										<div className="flex items-center gap-1">
											{onShuffleTweet && (
												<Button
													variant="ghost"
													size="sm"
													onClick={(e) => {
														e.stopPropagation();
														onShuffleTweet(id, tweet.slotTweetId);
													}}
													className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-blue-300"
												>
													<Shuffle className="h-3 w-3" />
												</Button>
											)}
											{onDeleteImage && (
												<Button
													variant="ghost"
													size="sm"
													onClick={(e) => {
														e.stopPropagation();
														onDeleteImage(id, photo.id);
													}}
													className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
												>
													<X className="h-3 w-3" />
												</Button>
											)}
										</div>
									)}
								</div>
							</div>
						</div>
					</div>
				);
			}

			// Multiple images layout with responsive grid
			return (
				<div
					key={tweet.id}
					className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md"
				>
					{/* Post header */}
					<div className="mb-3 flex items-center justify-between">
						<div>
							<p className="font-medium text-gray-900 text-sm">
								{tweet.artist}
							</p>
							<p className="text-gray-500 text-xs">
								{tweet.date &&
									formatTweetDate(
										typeof tweet.date === "string"
											? tweet.date
											: tweet.date.toISOString(),
									)}
							</p>
						</div>
						<div className="flex items-center gap-2">
							<span className="text-gray-500 text-xs">
								{tweet.photoCount} images
							</span>
							{status === "WAITING" && onShuffleTweet && (
								<Button
									variant="ghost"
									size="sm"
									onClick={(e) => {
										e.stopPropagation();
										onShuffleTweet(id, tweet.slotTweetId);
									}}
									className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-gray-600 hover:bg-gray-100 hover:text-blue-600"
								>
									<Shuffle className="h-3 w-3" />
								</Button>
							)}
						</div>
					</div>

					{/* Dynamic grid based on number of images */}
					{photos.length === 2 && (
						<div className="grid grid-cols-2 gap-2">
							{photos.map((photo) => (
								<div
									key={photo.id}
									className="group relative cursor-pointer overflow-hidden rounded bg-gray-100"
								>
									{isImageLoading[photo.id] && (
										<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
											<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
										</div>
									)}
									<img
										src={photo.url}
										alt={photo.alt}
										width={400}
										height={400}
										className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
										onLoadStart={() => handleImageLoadStart(photo.id)}
										onLoad={() => handleImageLoadWithLayout(photo.id)}
									/>
									<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
									{status === "WAITING" && onDeleteImage && (
										<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
											<Button
												variant="ghost"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													onDeleteImage(id, photo.id);
												}}
												className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
											>
												<X className="h-3 w-3" />
											</Button>
										</div>
									)}
								</div>
							))}
						</div>
					)}

					{photos.length === 3 && (
						<div className="grid grid-cols-2 gap-2">
							{photos.map((photo, index) => (
								<div
									key={photo.id}
									className={`group relative cursor-pointer overflow-hidden rounded bg-gray-100 ${
										index === 0 ? "col-span-2" : ""
									}`}
								>
									{isImageLoading[photo.id] && (
										<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
											<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
										</div>
									)}
									<img
										src={photo.url}
										alt={photo.alt}
										width={400}
										height={400}
										className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
										onLoadStart={() => handleImageLoadStart(photo.id)}
										onLoad={() => handleImageLoadWithLayout(photo.id)}
									/>
									<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
									{status === "WAITING" && onDeleteImage && (
										<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
											<Button
												variant="ghost"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													onDeleteImage(id, photo.id);
												}}
												className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
											>
												<X className="h-3 w-3" />
											</Button>
										</div>
									)}
								</div>
							))}
						</div>
					)}

					{photos.length === 4 && (
						<div className="grid grid-cols-2 gap-2">
							{photos.map((photo) => (
								<div
									key={photo.id}
									className="group relative cursor-pointer overflow-hidden rounded bg-gray-100"
								>
									{isImageLoading[photo.id] && (
										<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
											<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
										</div>
									)}
									<img
										src={photo.url}
										alt={photo.alt}
										width={400}
										height={400}
										className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
										onLoadStart={() => handleImageLoadStart(photo.id)}
										onLoad={() => handleImageLoadWithLayout(photo.id)}
									/>
									<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
									{status === "WAITING" && onDeleteImage && (
										<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
											<Button
												variant="ghost"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													onDeleteImage(id, photo.id);
												}}
												className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
											>
												<X className="h-3 w-3" />
											</Button>
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			);
		},
		[
			formatTweetDate,
			handleImageLoadStart,
			isImageLoading,
			handleImageLoadWithLayout,
			status,
			onShuffleTweet,
			onDeleteImage,
			id,
		],
	);

	return (
		<Card className={`overflow-hidden shadow-sm ${className}`}>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-2">
						{/* Date and Status */}
						<div className="flex items-center gap-2">
							<Badge variant="outline" className="gap-1 text-xs">
								<Calendar className="h-3 w-3" />
								{formatDate(scheduledFor)}
							</Badge>
							<Badge
								variant={getStatusVariant(status)}
								className="text-xs capitalize"
							>
								{status}
							</Badge>
						</div>

						{/* Summary */}
						<div className="flex flex-wrap items-center gap-2">
							{channelName && (
								<Badge variant="outline" className="text-xs">
									📢 {channelName}
								</Badge>
							)}
							<div className="flex items-center gap-1">
								<MessageSquare className="h-3 w-3 text-gray-500" />
								<span className="text-gray-500 text-xs">
									{scheduledSlotTweets.length} tweet
									{scheduledSlotTweets.length !== 1 ? "s" : ""}
								</span>
							</div>
							<span className="text-gray-500 text-xs">
								{totalPhotos} photo{totalPhotos !== 1 ? "s" : ""}
							</span>
							{uniqueAuthors.length > 0 && (
								<span className="text-gray-400 text-xs">
									@{uniqueAuthors.slice(0, 2).join(", @")}
									{uniqueAuthors.length > 2 && ` +${uniqueAuthors.length - 2}`}
								</span>
							)}
						</div>
					</div>

					{/* Mobile dropdown menu */}
					<div className="md:hidden">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" className="h-8 w-8 p-0">
									<MoreVertical className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-40">
								{onAddTweet && canAddMoreTweets && (
									<DropdownMenuItem
										onClick={() => onAddTweet(id)}
										className="gap-2"
									>
										<Plus className="h-4 w-4" />
										Add Tweet
									</DropdownMenuItem>
								)}

								{onDelete && status === "WAITING" && (
									<DropdownMenuItem
										onClick={() => onDelete(id)}
										className="gap-2 text-red-600 focus:text-red-600"
									>
										<Trash2 className="h-4 w-4" />
										Delete
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					{/* Desktop controls */}
					<div className="hidden items-center gap-1 md:flex">
						{onAddTweet && canAddMoreTweets && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => onAddTweet(id)}
								className="gap-1 text-xs"
							>
								<Plus className="h-3 w-3" />
								Add Tweet
							</Button>
						)}
						{onDelete && status === "WAITING" && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => onDelete(id)}
								className="gap-1 text-red-600 text-xs hover:bg-red-50 hover:text-red-700"
							>
								<Trash2 className="h-3 w-3" />
								Delete
							</Button>
						)}
					</div>
				</div>
			</CardHeader>

			<CardContent className="pt-0">
				{/* Images Masonry Grid */}
				<div
					ref={masonryGridRef}
					className={`masonry-grid w-full grid-cols-1 gap-4 overflow-hidden transition-opacity duration-200 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 ${
						isMasonryReady ? "opacity-100" : "opacity-0"
					}`}
				>
					{tweetsForDisplay.map((tweet, index) => (
						<div
							key={tweet.id}
							data-tweet-index={index}
							data-tweet-id={tweet.id}
							className="will-change-auto"
						>
							{renderTweetImages(tweet)}
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

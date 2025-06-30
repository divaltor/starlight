import type { ScheduledSlotStatus } from "@repo/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import {
	Calendar,
	MessageSquare,
	MoreVertical,
	Plus,
	Shuffle,
	Trash2,
	X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";

interface SlotTweet {
	id: string;
	tweet: {
		id: string;
		tweetData: Tweet;
	};
	scheduledSlotPhotos: Array<{
		id: string;
		photo: {
			id: string;
			s3Url: string;
		};
	}>;
}

interface SlotCardProps {
	id: string;
	scheduledFor: Date;
	createdAt: Date;
	status: ScheduledSlotStatus;
	scheduledSlotTweets: SlotTweet[];
	channelName?: string;
	onDelete?: (id: string) => void;
	onReshuffle?: (id: string) => void;
	onAddTweet?: (id: string) => void;
	onDeleteImage?: (id: string, photoId: string) => void;
	onShuffleTweet?: (id: string, tweetId: string) => void;
	className?: string;
}

export function SlotCard({
	id,
	scheduledFor,
	createdAt,
	status,
	scheduledSlotTweets,
	channelName,
	onDelete,
	onReshuffle,
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

	const getStatusColor = (status: string) => {
		switch (status) {
			case "waiting":
				return "bg-yellow-100 text-yellow-800 border-yellow-200";
			case "published":
				return "bg-blue-100 text-blue-800 border-blue-200";
			case "done":
				return "bg-green-100 text-green-800 border-green-200";
			default:
				return "bg-gray-100 text-gray-800 border-gray-200";
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
		scheduledSlotTweets.length < 5 && status === "WAITING";

	// Flatten all photos into a single array for masonry layout
	const allPhotos = scheduledSlotTweets.flatMap((slotTweet) =>
		slotTweet.scheduledSlotPhotos
			.filter((sp) => sp.photo.s3Url)
			.map((sp) => ({
				id: sp.photo.id,
				url: sp.photo.s3Url,
				tweetId: slotTweet.tweet.id,
				author: slotTweet.tweet.tweetData?.username || "unknown",
				date: slotTweet.tweet.tweetData?.timeParsed || "",
				slotTweetId: slotTweet.id,
			}))
	);

	const handleImageLoad = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: false }));
	}, []);

	const handleImageLoadStart = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: true }));
	}, []);

	// JavaScript masonry layout
	const layoutMasonry = useCallback(() => {
		const grid = masonryGridRef.current;
		if (!grid || allPhotos.length === 0) return;

		// Check if masonry is supported
		const supportsGridMasonry = CSS.supports("grid-template-rows", "masonry");
		if (supportsGridMasonry) {
			setIsMasonryReady(true);
			return;
		}

		const items = Array.from(grid.children) as HTMLElement[];
		if (items.length === 0) return;

		// Get grid gap
		const gap = 8; // 0.5rem = 8px

		// Calculate number of columns based on container width
		let columns = 2;
		const width = grid.offsetWidth;
		if (width >= 768) columns = 3;
		if (width >= 1024) columns = 4;

		// Calculate column width
		const columnWidth = (width - gap * (columns - 1)) / columns;

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
	}, [allPhotos.length]);

	// Trigger layout on data changes
	useEffect(() => {
		setIsMasonryReady(false);
		const timeoutId = setTimeout(layoutMasonry, 100);
		return () => clearTimeout(timeoutId);
	}, [layoutMasonry]);

	// Re-layout when images load
	const handleImageLoadWithLayout = useCallback(
		(imageId: string) => {
			handleImageLoad(imageId);
			setTimeout(layoutMasonry, 50);
		},
		[handleImageLoad, layoutMasonry],
	);

	return (
		<Card className={`overflow-hidden ${className}`}>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-2">
						{/* Date and Status */}
						<div className="flex items-center gap-2">
							<Badge
								variant="outline"
								className={`gap-1 text-xs ${getStatusColor(status)}`}
							>
								<Calendar className="h-3 w-3" />
								{formatDate(scheduledFor)}
							</Badge>
							<Badge
								variant={status === "WAITING" ? "default" : "secondary"}
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
								{onReshuffle && (
									<DropdownMenuItem
										onClick={() => onReshuffle(id)}
										className="gap-2"
									>
										<Shuffle className="h-4 w-4" />
										Reshuffle
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
						{onReshuffle && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => onReshuffle(id)}
								className="gap-1 text-xs"
							>
								<Shuffle className="h-3 w-3" />
								Reshuffle
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
				{allPhotos.length > 0 ? (
					<div
						ref={masonryGridRef}
						className={`masonry-grid grid-cols-2 gap-2 transition-opacity duration-200 md:grid-cols-3 lg:grid-cols-4 ${
							isMasonryReady ? "opacity-100" : "opacity-0"
						}`}
					>
						{allPhotos.map((photo) => (
							<div
								key={photo.id}
								className="group relative cursor-pointer overflow-hidden rounded-lg bg-gray-100 shadow-sm transition-shadow duration-300 hover:shadow-md will-change-auto"
							>
								{isImageLoading[photo.id] && (
									<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
										<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
									</div>
								)}
								<img
									src={photo.url}
									alt={`Photo by ${photo.author}`}
									width={400}
									height={400}
									className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
									onLoadStart={() => handleImageLoadStart(photo.id)}
									onLoad={() => handleImageLoadWithLayout(photo.id)}
								/>
								<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent">
									<div className="p-3 text-white w-full">
										<div className="flex items-center justify-between">
											<div>
												<p className="font-medium text-sm drop-shadow-lg">
													{photo.author}
												</p>
												{photo.date && (
													<p className="text-gray-200 text-xs drop-shadow-lg">
														{formatTweetDate(
															typeof photo.date === "string" ? photo.date : photo.date.toISOString()
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
																onShuffleTweet(id, photo.slotTweetId);
															}}
															className="h-6 w-6 p-0 flex-shrink-0 flex items-center justify-center text-white hover:text-blue-300 hover:bg-white/20"
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
															className="h-6 w-6 p-0 flex-shrink-0 flex items-center justify-center text-white hover:text-red-300 hover:bg-white/20"
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
						))}
					</div>
				) : (
					<div className="py-8 text-center">
						<MessageSquare className="mx-auto mb-2 h-12 w-12 text-gray-300" />
						<p className="text-gray-500 text-sm">No images in this slot</p>
						{canAddMoreTweets && onAddTweet && status === "WAITING" && (
							<Button
								variant="outline"
								onClick={() => onAddTweet(id)}
								className="mt-4 gap-2"
							>
								<Plus className="h-4 w-4" />
								Add Tweet
							</Button>
						)}
					</div>
				)}

				{/* Footer info */}
				<div className="mt-4 flex items-center justify-between gap-2 border-gray-100 border-t pt-4">
					<div className="text-gray-500 text-xs sm:text-sm">
						{scheduledSlotTweets.length} tweet
						{scheduledSlotTweets.length !== 1 ? "s" : ""}, {totalPhotos} photo
						{totalPhotos !== 1 ? "s" : ""}
					</div>

					<div className="text-gray-400 text-xs">
						Created{" "}
						{new Intl.DateTimeFormat("en-US", {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						}).format(createdAt)}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

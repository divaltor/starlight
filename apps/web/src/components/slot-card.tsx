import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, MoreVertical, Trash2 } from "lucide-react";
import {
	MasonryScroller,
	useContainerPosition,
	usePositioner,
	useResizeObserver,
} from "masonic";
import { useEffect, useMemo, useRef, useState } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import type {
	ScheduledSlot,
	ScheduledSlotTweet,
	ScheduledSlotWithTweets,
} from "@/routes/api/scheduled-slots";
import { shuffleTweet } from "@/routes/api/scheduled-slots";
import { deletePhoto } from "@/routes/api/scheduled-slots/photos";

interface SlotCardProps {
	id: string;
	status: "WAITING" | "PUBLISHED" | "PUBLISHING";
	scheduledSlotTweets: ScheduledSlotWithTweets;
	channelName?: string;
	onDelete?: (id: string) => void;
	className?: string;
}

export function SlotCard({
	id,
	status,
	scheduledSlotTweets,
	channelName,
	onDelete,
	className = "",
}: SlotCardProps) {
	const queryClient = useQueryClient();
	const { rawInitData } = useTelegramContext();
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

	const deletePhotoMutation = useMutation({
		mutationFn: async ({
			slotId,
			photoId,
		}: {
			slotId: string;
			photoId: string;
		}) => {
			return await deletePhoto({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					slotId,
					photoId,
				},
			});
		},
		onMutate: async ({ slotId, photoId }) => {
			await queryClient.cancelQueries({
				queryKey: ["scheduled-slots"],
			});

			const previousData = queryClient.getQueryData<ScheduledSlot[]>([
				"scheduled-slots",
			]);

			if (previousData) {
				const optimisticData = previousData
					.map((slot) => {
						if (slot.id === slotId) {
							const updatedSlot = {
								...slot,
								scheduledSlotTweets: slot.scheduledSlotTweets.map((tweet) => ({
									...tweet,
									scheduledSlotPhotos: tweet.scheduledSlotPhotos.filter(
										(photo) => photo.photo.id !== photoId,
									),
								})),
							};

							updatedSlot.scheduledSlotTweets =
								updatedSlot.scheduledSlotTweets.filter(
									(tweet) => tweet.scheduledSlotPhotos.length > 0,
								);

							return updatedSlot;
						}
						return slot;
					})
					.filter((slot) => slot.scheduledSlotTweets.length > 0);

				queryClient.setQueryData(["scheduled-slots"], optimisticData);
			}

			return { previousData };
		},
		onError: (_err, _variables, context) => {
			if (context?.previousData) {
				queryClient.setQueryData(["scheduled-slots"], context.previousData);
			}
		},
	});

	const handleDeleteImage = (slotId: string, photoId: string) => {
		deletePhotoMutation.mutate({ slotId, photoId });
	};

	const shuffleTweetMutation = useMutation({
		mutationFn: async ({
			slotId,
			tweetId,
		}: {
			slotId: string;
			tweetId: string;
		}) => {
			return await shuffleTweet({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					slotId,
					tweetId,
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots"],
			});
		},
	});

	const handleShuffleTweet = (slotId: string, tweetId: string) => {
		shuffleTweetMutation.mutate({ slotId, tweetId });
	};

	// useWindowSize hook
	const useWindowSize = () => {
		const [windowSize, setWindowSize] = useState({
			width: typeof window !== "undefined" ? window.innerWidth : 0,
			height: typeof window !== "undefined" ? window.innerHeight : 0,
		});

		useEffect(() => {
			const handleResize = () => {
				setWindowSize({
					width: window.innerWidth,
					height: window.innerHeight,
				});
			};

			window.addEventListener("resize", handleResize);
			return () => window.removeEventListener("resize", handleResize);
		}, []);

		return [windowSize.width, windowSize.height] as const;
	};

	// Track length for positioner - only use positioner when collection gets smaller
	const lengthRef = useRef<number>(0);
	const containerRef = useRef(null);
	const [windowWidth, windowHeight] = useWindowSize();

	// Track current and previous length to detect when collection gets smaller
	const currentLength = scheduledSlotTweets.length;
	const prevLengthRef = useRef<number | undefined>(undefined);

	const shouldRecalculate = useMemo(() => {
		const prevLength = prevLengthRef.current;
		prevLengthRef.current = currentLength;

		// Only recalculate when collection gets smaller
		return prevLength !== undefined && currentLength < prevLength;
	}, [currentLength]);

	// Set up masonry positioning - only recalculate when collection gets smaller
	const { offset, width } = useContainerPosition(containerRef, [
		windowWidth,
		windowHeight,
	]);

	const positioner = usePositioner(
		{
			width,
			columnWidth: 200, // Approximate column width
			columnGutter: 16,
		},
		[shouldRecalculate],
	);

	// Update length ref after positioner setup
	lengthRef.current = currentLength;

	const resizeObserver = useResizeObserver(positioner);

	const renderMasonryItem = ({
		data,
		width,
	}: {
		data: ScheduledSlotTweet;
		width: number;
	}) => {
		return (
			<div style={{ width }} className="mb-1">
				<TweetImageGrid
					id={id}
					artist={data.tweet.tweetData?.username || "unknown"}
					date={data.tweet.tweetData?.timeParsed || ""}
					photos={data.scheduledSlotPhotos.map((photo) => ({
						id: photo.photo.id,
						url: photo.photo.s3Url || "",
					}))}
					showActions={status === "WAITING"}
					onShuffleTweet={handleShuffleTweet}
					onDeleteImage={handleDeleteImage}
					slotTweetId={data.id}
					sourceUrl={`https://x.com/i/status/${data.tweet.id}`}
				/>
			</div>
		);
	};

	return (
		<Card className={`overflow-hidden shadow-sm ${className}`}>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-2">
						{/* Date and Status */}
						<div className="flex items-center gap-2">
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
				{scheduledSlotTweets.length > 0 && (
					<div ref={containerRef} style={{ position: "relative" }}>
						<MasonryScroller
							positioner={positioner}
							resizeObserver={resizeObserver}
							containerRef={containerRef}
							items={scheduledSlotTweets}
							height={windowHeight}
							offset={offset}
							overscanBy={3}
							render={renderMasonryItem}
						/>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

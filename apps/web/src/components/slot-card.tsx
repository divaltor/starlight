import type { TweetData } from "@starlight/api/src/types/tweets";
import type { ScheduledSlot } from "@starlight/utils";
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
import { orpc } from "@/utils/orpc";

type SlotCardProps = {
	tweets: TweetData[];
	slot?: ScheduledSlot;
};

export function SlotCard({ tweets, slot }: SlotCardProps) {
	const queryClient = useQueryClient();
	const showActions = slot?.status === "WAITING";
	// Track length for positioner - only use positioner when collection gets smaller
	const lengthRef = useRef<number>(0);
	const containerRef = useRef(null);

	const totalPhotos = tweets.reduce(
		(sum, tweet) => sum + tweet.photos.length,
		0
	);
	const uniqueAuthors = [...new Set(tweets.map((tweet) => tweet.artist))];

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

	const [windowWidth, windowHeight] = useWindowSize();

	// Track current and previous length to detect when collection gets smaller
	const currentLength = tweets.length;
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
		[shouldRecalculate]
	);

	// Update length ref after positioner setup
	lengthRef.current = currentLength;

	const resizeObserver = useResizeObserver(positioner);

	const renderMasonryItem = ({
		data,
		width,
	}: {
		data: TweetData;
		width: number;
	}) => (
		<div className="mb-1" style={{ width }}>
			<TweetImageGrid
				onDeleteImage={handleDeleteImage}
				onShuffleTweet={handleShuffleTweet}
				showActions={showActions}
				slot={slot}
				tweet={data}
			/>
		</div>
	);

	const deletePhotoMutation = useMutation(
		orpc.scheduling.photos.remove.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const shuffleTweetMutation = useMutation(
		orpc.scheduling.tweets.shuffle.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const deleteSlotMutation = useMutation(
		orpc.scheduling.slots.delete.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const handleDeleteSlot = () => {
		if (slot?.id) {
			deleteSlotMutation.mutate({ slotId: slot.id });
		}
	};

	const handleDeleteImage = (photoId: string) => {
		if (slot) {
			deletePhotoMutation.mutate({ slotId: slot.id, photoId });
		}
	};

	const handleShuffleTweet = (tweetId: string) => {
		if (slot?.id) {
			shuffleTweetMutation.mutate({ slotId: slot.id, tweetId });
		}
	};

	return (
		<Card className="overflow-hidden shadow-sm">
			<CardHeader className={tweets.length > 0 ? "pb-3" : "pb-0"}>
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-2">
						{/* Summary */}
						<div className="flex flex-wrap items-center gap-2">
							{slot?.chatId && (
								<Badge className="text-xs" variant="outline">
									📢 {slot?.chatId}
								</Badge>
							)}
							<div className="flex items-center gap-1">
								<MessageSquare className="h-3 w-3 text-gray-500" />
								<span className="text-gray-500 text-xs">
									{tweets.length} tweet
									{tweets.length !== 1 ? "s" : ""}
								</span>
							</div>
							<span className="text-gray-500 text-xs">
								{totalPhotos} photo{totalPhotos !== 1 ? "s" : ""}
							</span>
							{uniqueAuthors.length > 0 && (
								<span className="text-gray-400 text-xs">
									{uniqueAuthors
										.slice(0, 2)
										.map((author) => author)
										.join(", ")}
									{uniqueAuthors.length > 2 &&
										` +${uniqueAuthors.length - 2} more`}
								</span>
							)}
						</div>
					</div>

					{/* Mobile dropdown menu */}
					<div className="md:hidden">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button className="h-8 w-8 p-0" size="sm" variant="ghost">
									<MoreVertical className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-40">
								{showActions && (
									<DropdownMenuItem
										className="gap-2 text-red-600 focus:text-red-600"
										onClick={handleDeleteSlot}
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
						{showActions && (
							<Button
								className="gap-1 text-red-600 text-xs hover:bg-red-50 hover:text-red-700"
								onClick={handleDeleteSlot}
								size="sm"
								variant="outline"
							>
								<Trash2 className="h-3 w-3" />
								Delete
							</Button>
						)}
					</div>
				</div>
			</CardHeader>
			<CardContent className={tweets.length > 0 ? "p-0" : ""}>
				{tweets.length > 0 && (
					<div ref={containerRef} style={{ position: "relative" }}>
						<MasonryScroller
							containerRef={containerRef}
							height={windowHeight}
							items={tweets}
							offset={offset}
							overscanBy={3}
							positioner={positioner}
							render={renderMasonryItem}
							resizeObserver={resizeObserver}
						/>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

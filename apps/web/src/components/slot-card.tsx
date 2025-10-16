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
import type { ScheduledSlotWithTweets, TweetWithPhotos } from "@/types/api";
import { orpc } from "@/utils/orpc";

type SlotCardProps = {
	slot: ScheduledSlotWithTweets;
	onDelete?: (id: string) => void;
	className?: string;
};

export function SlotCard({ slot, onDelete, className = "" }: SlotCardProps) {
	const queryClient = useQueryClient();

	const totalPhotos = slot.scheduledSlotTweets.reduce(
		(sum, tweet) => sum + tweet.scheduledSlotPhotos.length,
		0
	);

	const uniqueAuthors = [
		...new Set(
			slot.scheduledSlotTweets.map(
				(tweet) => tweet.tweet.tweetData?.username ?? "unknown"
			)
		),
	];

	const deletePhotoMutation = useMutation(
		orpc.scheduling.photos.remove.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
			onMutate: async (newData) => {
				await queryClient.cancelQueries({
					queryKey: ["scheduled-slots"],
				});

				const previousSlot = queryClient.getQueryData<ScheduledSlotWithTweets>([
					"scheduled-slots",
				]);

				if (previousSlot) {
					const updatedSlot = {
						...previousSlot,
						scheduledSlotTweets: previousSlot.scheduledSlotTweets.map(
							(tweet) => ({
								...tweet,
								scheduledSlotPhotos: tweet.scheduledSlotPhotos.filter(
									(photo) => photo.photo.id !== newData.photoId
								),
							})
						),
					};

					queryClient.setQueryData(["scheduled-slots"], updatedSlot);
				}

				return { previousSlot };
			},
			onError: (_err, _variables, context) => {
				if (context?.previousSlot) {
					queryClient.setQueryData(["scheduled-slots"], context.previousSlot);
				}
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
	const currentLength = slot.scheduledSlotTweets.length;
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
		data: TweetWithPhotos;
		width: number;
	}) => (
		<div className="mb-1" style={{ width }}>
			<TweetImageGrid
				onDeleteImage={(photoId) =>
					deletePhotoMutation.mutate({ slotId: slot.id, photoId })
				}
				onShuffleTweet={(tweetId) =>
					shuffleTweetMutation.mutate({ slotId: slot.id, tweetId })
				}
				scheduledTweet={data}
				showActions={slot.status === "WAITING"}
			/>
		</div>
	);

	return (
		<Card className={`overflow-hidden shadow-sm ${className}`}>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-2">
						{/* Summary */}
						<div className="flex flex-wrap items-center gap-2">
							{slot.postingChannel.chat.title && (
								<Badge className="text-xs" variant="outline">
									📢 {slot.postingChannel.chat.title}
								</Badge>
							)}
							<div className="flex items-center gap-1">
								<MessageSquare className="h-3 w-3 text-gray-500" />
								<span className="text-gray-500 text-xs">
									{slot.scheduledSlotTweets.length} tweet
									{slot.scheduledSlotTweets.length !== 1 ? "s" : ""}
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
								<Button className="h-8 w-8 p-0" size="sm" variant="ghost">
									<MoreVertical className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-40">
								{onDelete && slot.status === "WAITING" && (
									<DropdownMenuItem
										className="gap-2 text-red-600 focus:text-red-600"
										onClick={() => onDelete(slot.id)}
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
						{onDelete && slot.status === "WAITING" && (
							<Button
								className="gap-1 text-red-600 text-xs hover:bg-red-50 hover:text-red-700"
								onClick={() => onDelete(slot.id)}
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

			<CardContent className="pt-0">
				{slot.scheduledSlotTweets.length > 0 && (
					<div ref={containerRef} style={{ position: "relative" }}>
						<MasonryScroller
							containerRef={containerRef}
							height={windowHeight}
							items={slot.scheduledSlotTweets}
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

import type {
	ScheduledSlotData,
	ScheduledSlotResult,
	TweetData,
} from "@starlight/api/src/types/tweets";
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
	slot: ScheduledSlotData;
};

export function SlotCard({ tweets, slot }: SlotCardProps) {
	const queryClient = useQueryClient();
	const showActions = slot?.status === "WAITING";
	const lengthRef = useRef<number>(0);
	const containerRef = useRef<HTMLDivElement>(null);

	const scrollerRef = useRef<HTMLDivElement>(null);
	const [adjustment, setAdjustment] = useState<{
		oldHeight: number;
		affectedTweetId: string;
		oldScrollTop: number;
		oldTop: number;
	} | null>(null);
	const [version, setVersion] = useState(0);
	const prevTweetsLengthRef = useRef(tweets.length);

	const totalPhotos = useMemo(
		() => tweets.reduce((sum, tweet) => sum + tweet.photos.length, 0),
		[tweets]
	);
	const uniqueAuthors = useMemo(
		() => [...new Set(tweets.map((tweet) => tweet.artist))],
		[tweets]
	);

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
		[tweets, version]
	);

	useEffect(() => {
		scrollerRef.current = containerRef.current
			?.parentElement as HTMLDivElement | null;
	}, []);

	lengthRef.current = tweets.length;

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
				onDeleteImage={(photoId) =>
					deletePhotoMutation.mutate({ slotId: slot.id, photoId })
				}
				onShuffleTweet={(tweetId) =>
					shuffleTweetMutation.mutate({ slotId: slot.id, tweetId })
				}
				showActions={showActions}
				slot={slot}
				tweet={data}
			/>
		</div>
	);

	const deletePhotoMutation = useMutation(
		orpc.scheduling.photos.remove.mutationOptions({
			onMutate: async (variables: { slotId: string; photoId: string }) => {
				await queryClient.cancelQueries({ queryKey: ["scheduled-slots"] });
				const previousData = queryClient.getQueryData<ScheduledSlotResult>([
					"scheduled-slots",
				]);

				const affectedIndex =
					previousData?.tweets.findIndex((t: TweetData) =>
						t.photos.some((p) => p.id === variables.photoId)
					) ?? -1;

				let affTweetId = "";
				let oldHeight = 0;
				let oldTop = 0;
				let oldScrollTop = 0;

				if (
					previousData &&
					affectedIndex !== -1 &&
					typeof positioner === "function" &&
					scrollerRef.current
				) {
					const pos = (positioner as any)(affectedIndex);
					oldHeight = pos.height;
					oldTop = pos.top;
					oldScrollTop = scrollerRef.current.scrollTop;
					affTweetId = previousData.tweets[affectedIndex].id;
				}

				queryClient.setQueryData<ScheduledSlotResult>(
					["scheduled-slots"],
					(old?: ScheduledSlotResult) => {
						if (!old) {
							return old;
						}

						const newTweets = old.tweets
							.map((t: TweetData) => ({
								...t,
								photos: t.photos.filter((p) => p.id !== variables.photoId),
							}))
							.filter((t: TweetData) => t.photos.length > 0);

						return {
							...old,
							tweets: newTweets,
						};
					}
				);

				setVersion((v) => v + 1);

				if (affTweetId) {
					setAdjustment({
						oldHeight,
						affectedTweetId: affTweetId,
						oldScrollTop,
						oldTop,
					});
				}

				return { previousData };
			},
			onError: (
				_error: unknown,
				_variables: unknown,
				context?: { previousData?: ScheduledSlotResult }
			) => {
				if (context?.previousData) {
					queryClient.setQueryData(["scheduled-slots"], context.previousData);
				}
				setAdjustment(null);
				setVersion((v) => v + 1);
			},
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
				setVersion((v) => v + 1);
			},
		})
	);

	const shuffleTweetMutation = useMutation(
		orpc.scheduling.tweets.shuffle.mutationOptions({
			onMutate: async (variables: { slotId: string; tweetId: string }) => {
				await queryClient.cancelQueries({ queryKey: ["scheduled-slots"] });
				const previousData = queryClient.getQueryData<ScheduledSlotResult>([
					"scheduled-slots",
				]);

				const affectedIndex =
					previousData?.tweets.findIndex(
						(t: TweetData) => t.id === variables.tweetId
					) ?? -1;

				const affTweetId = variables.tweetId;
				let oldHeight = 0;
				let oldTop = 0;
				let oldScrollTop = 0;

				if (
					affectedIndex !== -1 &&
					typeof positioner === "function" &&
					scrollerRef.current
				) {
					const pos = (positioner as any)(affectedIndex);
					oldHeight = pos.height;
					oldTop = pos.top;
					oldScrollTop = scrollerRef.current.scrollTop;
				}

				queryClient.setQueryData(
					["scheduled-slots"],
					(old?: ScheduledSlotResult) => {
						if (!old) {
							return old;
						}

						return {
							...old,
							tweets: old.tweets.map((t: TweetData) =>
								t.id === variables.tweetId
									? {
											...t,
											photos: [...t.photos].sort(() => Math.random() - 0.5),
										}
									: t
							),
						};
					}
				);

				setVersion((v) => v + 1);

				setAdjustment({
					oldHeight,
					affectedTweetId: affTweetId,
					oldScrollTop,
					oldTop,
				});

				return { previousData };
			},
			onError: (
				_error: unknown,
				_variables: unknown,
				context?: { previousData?: ScheduledSlotResult }
			) => {
				if (context?.previousData) {
					queryClient.setQueryData(["scheduled-slots"], context.previousData);
				}
				setAdjustment(null);
				setVersion((v) => v + 1);
			},
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
				setVersion((v) => v + 1);
			},
		})
	);

	const deleteSlotMutation = useMutation(
		orpc.scheduling.slots.delete.mutationOptions({
			onMutate: async () => {
				await queryClient.cancelQueries({ queryKey: ["scheduled-slots"] });
				const previousData = queryClient.getQueryData<ScheduledSlotResult>([
					"scheduled-slots",
				]);

				queryClient.setQueryData<ScheduledSlotResult>(
					["scheduled-slots"],
					() => ({ slot: null, tweets: [] }) satisfies ScheduledSlotResult
				);

				setVersion((v) => v + 1);

				return { previousData };
			},
			onError: (
				_error: unknown,
				_variables: unknown,
				context?: { previousData?: ScheduledSlotResult }
			) => {
				if (context?.previousData) {
					queryClient.setQueryData(["scheduled-slots"], context.previousData);
				}
				setAdjustment(null);
				setVersion((v) => v + 1);
			},
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
				setVersion((v) => v + 1);
			},
		})
	);

	const handleDeleteSlot = () => {
		deleteSlotMutation.mutate({ slotId: slot.id });
	};

	useEffect(() => {
		if (
			adjustment &&
			scrollerRef.current &&
			typeof positioner === "function" &&
			tweets
		) {
			const newIndex = tweets.findIndex(
				(t: TweetData) => t.id === adjustment.affectedTweetId
			);
			let newHeight = 0;
			if (newIndex !== -1) {
				const newPos = (positioner as any)(newIndex);
				newHeight = newPos.height;
			}
			const delta = adjustment.oldHeight - newHeight;
			if (delta > 0 && adjustment.oldTop < adjustment.oldScrollTop) {
				scrollerRef.current.scrollTop = Math.max(
					0,
					adjustment.oldScrollTop - delta
				);
			}
			setAdjustment(null);
		}
	}, [adjustment, tweets, positioner]);

	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) {
			return;
		}

		const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 5; // tolerance for floating point
		const prevLength = prevTweetsLengthRef.current;

		if (tweets.length > prevLength && atBottom) {
			// Was at bottom before add, scroll to new bottom after layout
			requestAnimationFrame(() => {
				if (el) {
					el.scrollTop = el.scrollHeight - el.clientHeight;
				}
			});
		}

		prevTweetsLengthRef.current = tweets.length;
	}, [tweets.length, tweets]); // Run on length change

	return (
		<Card className="card-border pt-4">
			<CardHeader className={tweets.length > 0 ? "pb-3" : "pb-0"}>
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-2">
						{/* Summary */}
						<div className="flex flex-wrap items-center gap-2">
							{slot.chat.title && (
								<Badge size="sm" variant="accent">
									#{slot.chat.title}
								</Badge>
							)}
							<div className="flex items-center gap-1">
								<MessageSquare className="h-3 w-3 text-base-content/60" />
								<span className="text-base-content/60 text-xs">
									{tweets.length} tweet
									{tweets.length !== 1 ? "s" : ""}
								</span>
							</div>
							<span className="text-base-content/60 text-xs">
								{totalPhotos} photo{totalPhotos !== 1 ? "s" : ""}
							</span>
							{uniqueAuthors.length > 0 && (
								<span className="text-base-content/60 text-xs">
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
							<DropdownMenuTrigger>
								<Button className="h-8 w-8 p-0" size="sm" variant="ghost">
									<MoreVertical className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-40">
								{showActions && (
									<DropdownMenuItem
										className="gap-2 text-error"
										onClick={handleDeleteSlot}
									>
										<Trash2 className="h-4 w-4 text-error" />
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
								onClick={handleDeleteSlot}
								size="sm"
								variant="destructive"
							>
								<Trash2 className="h-3 w-3" />
								Delete
							</Button>
						)}
					</div>
				</div>
			</CardHeader>
			<CardContent className="pt-0">
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

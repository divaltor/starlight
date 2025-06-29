import type { ScheduledSlotStatus } from "@repo/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import {
	Calendar,
	Clock,
	MessageSquare,
	MoreVertical,
	Plus,
	Shuffle,
	Trash2,
} from "lucide-react";
import { TweetCard } from "@/components/tweet-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
	onReshuffleImage?: (id: string, photoId: string) => void;
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
	onReshuffleImage,
	className = "",
}: SlotCardProps) {
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

	const formatTime = (date: Date) => {
		return new Intl.DateTimeFormat("en-US", {
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	};

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

	return (
		<Card className={`overflow-hidden ${className}`}>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-2">
						{/* Date and Time */}
						<div className="flex items-center gap-2">
							<Badge
								variant="outline"
								className={`gap-1 text-xs ${getStatusColor(status)}`}
							>
								<Calendar className="h-3 w-3" />
								{formatDate(scheduledFor)}
							</Badge>
						</div>

						{/* Status and Summary */}
						<div className="flex flex-wrap items-center gap-2">
							<Badge
								variant={status === "WAITING" ? "default" : "secondary"}
								className="text-xs capitalize"
							>
								{status}
							</Badge>
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
										Reshuffle All
									</DropdownMenuItem>
								)}
								{onDelete && status === "WAITING" && (
									<DropdownMenuItem
										onClick={() => onDelete(id)}
										className="gap-2 text-red-600 focus:text-red-600"
									>
										<Trash2 className="h-4 w-4" />
										Delete Slot
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
				{/* Tweets */}
				{scheduledSlotTweets.length > 0 ? (
					<div className="space-y-3">
						{scheduledSlotTweets.map((slotTweet) => (
							<TweetCard
								key={slotTweet.id}
								author={slotTweet.tweet.tweetData?.username || "unknown"}
								createdAt={
									slotTweet.tweet.tweetData?.timeParsed
										? new Date(slotTweet.tweet.tweetData.timeParsed)
										: undefined
								}
								photos={slotTweet.scheduledSlotPhotos.map((sp) => ({
									id: sp.photo.id,
									url: sp.photo.s3Url,
								}))}
								onDeleteImage={
									onDeleteImage && status === "WAITING"
										? (photoId) => onDeleteImage(id, photoId)
										: undefined
								}
								onReshuffleImage={
									onReshuffleImage && status === "WAITING"
										? (photoId) => onReshuffleImage(id, photoId)
										: undefined
								}
								readonly={status !== "WAITING"}
							/>
						))}

						{/* Add tweet button */}
						{canAddMoreTweets && onAddTweet && status === "WAITING" && (
							<button
								type="button"
								onClick={() => onAddTweet(id)}
								className="flex w-full items-center justify-center rounded-lg border-2 border-gray-300 border-dashed bg-gray-50 py-4 transition-transform hover:border-gray-400 hover:bg-gray-100 active:scale-95"
							>
								<div className="flex items-center gap-2 text-gray-500">
									<Plus className="h-5 w-5" />
									<span className="text-sm">Add Another Tweet</span>
								</div>
							</button>
						)}
					</div>
				) : (
					<div className="py-8 text-center">
						<MessageSquare className="mx-auto mb-2 h-12 w-12 text-gray-300" />
						<p className="text-gray-500 text-sm">No tweets in this slot</p>
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

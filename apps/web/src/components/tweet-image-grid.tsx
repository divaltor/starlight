import type {
	ScheduledSlotData,
	TweetData,
} from "@starlight/api/src/types/tweets";
import { format } from "date-fns";
import { Shuffle, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type TweetImageGridProps = {
	tweet: TweetData;
	slot?: ScheduledSlotData;
	showActions?: boolean;
	onShuffleTweet?: (tweetId: string) => void;
	onDeleteImage?: (photoId: string) => void;
};

export function TweetImageGrid({
	tweet,
	slot,
	showActions = false,
	onShuffleTweet,
	onDeleteImage,
}: TweetImageGridProps) {
	const [isImageLoading, setIsImageLoading] = useState<{
		[key: string]: boolean;
	}>({});

	const formatTweetDate = format(new Date(tweet.date), "MMM d, yyyy");

	const handleImageLoad = (imageId: string, isLoading: boolean) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: isLoading }));
	};

	const handleArtistClick = (e: React.MouseEvent) => {
		e.stopPropagation();

		window.open(tweet.sourceUrl, "_blank", "noopener,noreferrer");
	};

	if (tweet.photos.length === 1) {
		const photo = tweet.photos[0];

		return (
			<div className="group relative cursor-pointer overflow-hidden rounded-lg bg-gray-100 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md">
				{isImageLoading[photo.id] && (
					<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
						<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
					</div>
				)}
				{/** biome-ignore lint/a11y/useAltText: Fuck off */}
				{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
				<img
					className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
					height={400}
					onLoad={() => handleImageLoad(photo.id, false)}
					onLoadStart={() => handleImageLoad(photo.id, true)}
					src={photo.url}
					width={400}
				/>
				<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
				<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent">
					<div className="w-full p-3 text-white">
						<div className="flex items-center justify-between">
							<div>
								<button
									className="cursor-pointer text-left font-medium text-sm text-white drop-shadow-lg transition-colors duration-200 hover:text-blue-300"
									onClick={(e) => handleArtistClick(e)}
									type="button"
								>
									{tweet.artist}
								</button>
								<p className="font-medium text-sm drop-shadow-lg">
									{formatTweetDate}
								</p>
							</div>
							{showActions && slot && (
								<div className="flex items-center gap-1">
									{onShuffleTweet && (
										<Button
											className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-blue-300"
											onClick={(e) => {
												e.stopPropagation();
												onShuffleTweet(tweet.id);
											}}
											size="sm"
											variant="ghost"
										>
											<Shuffle className="h-3 w-3" />
										</Button>
									)}
									{onDeleteImage && (
										<Button
											className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
											onClick={(e) => {
												e.stopPropagation();
												onDeleteImage(photo.id);
											}}
											size="sm"
											variant="ghost"
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
		<div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md">
			{/* Post header */}
			<div className="mb-3 flex items-center justify-between">
				<div>
					<button
						className="cursor-pointer text-left font-medium text-gray-900 text-sm transition-colors duration-200 hover:text-blue-600"
						onClick={(e) => handleArtistClick(e)}
						type="button"
					>
						{tweet.artist}
					</button>
					<p className="text-gray-500 text-xs">{formatTweetDate}</p>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-gray-500 text-xs">
						{tweet.photos.length} images
					</span>
					{showActions && onShuffleTweet && slot && (
						<Button
							className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-gray-600 hover:bg-gray-100 hover:text-blue-600"
							onClick={(e) => {
								e.stopPropagation();
								onShuffleTweet(tweet.id);
							}}
							size="sm"
							variant="ghost"
						>
							<Shuffle className="h-3 w-3" />
						</Button>
					)}
				</div>
			</div>
			{/* Dynamic grid based on number of images */}
			{tweet.photos.length === 2 && (
				<div className="grid grid-cols-2 gap-2">
					{tweet.photos.map((photo) => (
						<div
							className="group relative cursor-pointer overflow-hidden rounded bg-gray-100"
							key={photo.id}
						>
							{isImageLoading[photo.id] && (
								<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
									<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
								</div>
							)}
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
							<img
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
								height={400}
								onLoad={() => handleImageLoad(photo.id, false)}
								onLoadStart={() => handleImageLoad(photo.id, true)}
								src={photo.url}
								width={400}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slot && (
								<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
									<Button
										className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
										onClick={(e) => {
											e.stopPropagation();
											onDeleteImage(photo.id);
										}}
										size="sm"
										variant="ghost"
									>
										<X className="h-3 w-3" />
									</Button>
								</div>
							)}
						</div>
					))}
				</div>
			)}
			{tweet.photos.length === 3 && (
				<div className="grid grid-cols-2 gap-2">
					{tweet.photos.map((photo, index) => (
						<div
							className={`group relative cursor-pointer overflow-hidden rounded bg-gray-100 ${
								index === 0 ? "col-span-2" : ""
							}`}
							key={photo.id}
						>
							{isImageLoading[photo.id] && (
								<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
									<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
								</div>
							)}
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
							<img
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
								height={400}
								onLoad={() => handleImageLoad(photo.id, false)}
								onLoadStart={() => handleImageLoad(photo.id, true)}
								src={photo.url}
								width={400}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slot && (
								<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
									<Button
										className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
										onClick={(e) => {
											e.stopPropagation();
											onDeleteImage(photo.id);
										}}
										size="sm"
										variant="ghost"
									>
										<X className="h-3 w-3" />
									</Button>
								</div>
							)}
						</div>
					))}
				</div>
			)}
			{tweet.photos.length === 4 && (
				<div className="grid grid-cols-2 gap-2">
					{tweet.photos.map((photo) => (
						<div
							className="group relative cursor-pointer overflow-hidden rounded bg-gray-100"
							key={photo.id}
						>
							{isImageLoading[photo.id] && (
								<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
									<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
								</div>
							)}
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
							<img
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
								height={400}
								onLoad={() => handleImageLoad(photo.id, false)}
								onLoadStart={() => handleImageLoad(photo.id, true)}
								src={photo.url}
								width={400}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slot && (
								<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
									<Button
										className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-red-300"
										onClick={(e) => {
											e.stopPropagation();
											onDeleteImage(photo.id);
										}}
										size="sm"
										variant="ghost"
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
}

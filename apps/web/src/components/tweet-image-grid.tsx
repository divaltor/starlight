import type {
	ScheduledSlotData,
	TweetData,
} from "@starlight/api/src/types/tweets";
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
			<div className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md">
				{isImageLoading[photo.id] && (
					<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
						<div className="loading loading-spinner loading-sm" />
					</div>
				)}
				{/** biome-ignore lint/a11y/useAltText: Fuck off */}
				{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
				<img
					className="h-auto w-full transition-transform duration-300 group-hover:scale-105 dark:brightness-80 dark:contrast-105"
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
									className="cursor-pointer text-left font-medium text-sm text-white drop-shadow-lg transition-colors duration-200 hover:text-primary"
									onClick={(e) => handleArtistClick(e)}
									type="button"
								>
									{tweet.artist}
								</button>
							</div>
							{showActions && slot && (
								<div className="flex items-center gap-1">
									{onShuffleTweet && (
										<Button
											className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-white hover:bg-white/20 hover:text-primary"
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
											className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md p-0 text-white hover:bg-white/20 hover:text-error"
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
		<div className="rounded-box border border-base-200 bg-base-100 p-3 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md">
			{/* Post header */}
			<div className="mb-3 flex items-center justify-between">
				<div>
					<button
						className="cursor-pointer text-left font-medium text-base-content text-sm transition-colors duration-200 hover:text-primary"
						onClick={(e) => handleArtistClick(e)}
						type="button"
					>
						{tweet.artist}
					</button>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-base-content/60 text-xs">
						{tweet.photos.length} images
					</span>
					{showActions && onShuffleTweet && slot && (
						<Button
							className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-base-content/60 hover:bg-base-200 hover:text-primary"
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
							className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100"
							key={photo.id}
						>
							{isImageLoading[photo.id] && (
								<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
									<div className="loading loading-spinner loading-sm" />
								</div>
							)}
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
							<img
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105 dark:brightness-80 dark:contrast-105"
								height={400}
								onLoad={() => handleImageLoad(photo.id, false)}
								onLoadStart={() => handleImageLoad(photo.id, true)}
								src={photo.url}
								width={400}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slot && (
								<div className="absolute top-2 right-2">
									<Button
										className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-black/50 p-0 text-white hover:text-error"
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
							className={`group relative cursor-pointer overflow-hidden rounded-box bg-base-100 ${
								index === 0 ? "col-span-2" : ""
							}`}
							key={photo.id}
						>
							{isImageLoading[photo.id] && (
								<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
									<div className="loading loading-spinner loading-sm" />
								</div>
							)}
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
							<img
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105 dark:brightness-80 dark:contrast-105"
								height={400}
								onLoad={() => handleImageLoad(photo.id, false)}
								onLoadStart={() => handleImageLoad(photo.id, true)}
								src={photo.url}
								width={400}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slot && (
								<div className="absolute top-2 right-2">
									<Button
										className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-black/50 p-0 text-white hover:text-error"
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
							className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100"
							key={photo.id}
						>
							{isImageLoading[photo.id] && (
								<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
									<div className="loading loading-spinner loading-sm" />
								</div>
							)}
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
							<img
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105 dark:brightness-80 dark:contrast-105"
								height={400}
								onLoad={() => handleImageLoad(photo.id, false)}
								onLoadStart={() => handleImageLoad(photo.id, true)}
								src={photo.url}
								width={400}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slot && (
								<div className="absolute top-2 right-2">
									<Button
										className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-black/50 p-0 text-white hover:text-error"
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

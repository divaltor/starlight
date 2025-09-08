import { format } from "date-fns";
import { Shuffle, X } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";

interface TweetPhoto {
	id: string;
	url: string;
}

interface TweetImageGridProps {
	id: string;
	artist: string;
	date?: string | Date;
	photos: TweetPhoto[];
	showActions?: boolean;
	onShuffleTweet?: (id: string, tweetId: string) => void;
	onDeleteImage?: (id: string, photoId: string) => void;
	slotTweetId?: string;
	sourceUrl?: string;
}

export function TweetImageGrid({
	id,
	artist,
	date,
	photos,
	showActions = false,
	onShuffleTweet,
	onDeleteImage,
	slotTweetId,
	sourceUrl,
}: TweetImageGridProps) {
	const [isImageLoading, setIsImageLoading] = useState<{
		[key: string]: boolean;
	}>({});

	const handleImageLoad = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: false }));
	}, []);

	const handleImageLoadStart = useCallback((imageId: string) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: true }));
	}, []);

	const formatTweetDate = useCallback((dateInput: string | Date) => {
		const dateObj =
			typeof dateInput === "string" ? new Date(dateInput) : dateInput;
		return format(dateObj, "MMM d, yyyy");
	}, []);

	const handleArtistClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (sourceUrl) {
				window.open(sourceUrl, "_blank", "noopener,noreferrer");
			}
		},
		[sourceUrl],
	);

	if (photos.length === 1) {
		const photo = photos[0];

		return (
			<div className="group relative cursor-pointer overflow-hidden rounded-lg bg-gray-100 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md">
				{isImageLoading[photo.id] && (
					<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
						<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
					</div>
				)}
				{/** biome-ignore lint/a11y/useAltText: Fuck off */}
				<img
					src={photo.url}
					width={400}
					height={400}
					className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
					onLoadStart={() => handleImageLoadStart(photo.id)}
					onLoad={() => handleImageLoad(photo.id)}
				/>
				<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
				<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent">
					<div className="w-full p-3 text-white">
						<div className="flex items-center justify-between">
							<div>
								{sourceUrl ? (
									<button
										type="button"
										onClick={handleArtistClick}
										className="cursor-pointer text-left font-medium text-sm text-white drop-shadow-lg transition-colors duration-200 hover:text-blue-300"
									>
										{artist}
									</button>
								) : (
									<p className="font-medium text-sm drop-shadow-lg">{artist}</p>
								)}
								{date && (
									<p className="text-gray-200 text-xs drop-shadow-lg">
										{formatTweetDate(date)}
									</p>
								)}
							</div>
							{showActions && slotTweetId && (
								<div className="flex items-center gap-1">
									{onShuffleTweet && (
										<Button
											variant="ghost"
											size="sm"
											onClick={(e) => {
												e.stopPropagation();
												onShuffleTweet(id, slotTweetId);
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
		<div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md">
			{/* Post header */}
			<div className="mb-3 flex items-center justify-between">
				<div>
					{sourceUrl ? (
						<button
							type="button"
							onClick={handleArtistClick}
							className="cursor-pointer text-left font-medium text-gray-900 text-sm transition-colors duration-200 hover:text-blue-600"
						>
							{artist}
						</button>
					) : (
						<p className="font-medium text-gray-900 text-sm">{artist}</p>
					)}
					<p className="text-gray-500 text-xs">
						{date && formatTweetDate(date)}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-gray-500 text-xs">{photos.length} images</span>
					{showActions && onShuffleTweet && slotTweetId && (
						<Button
							variant="ghost"
							size="sm"
							onClick={(e) => {
								e.stopPropagation();
								onShuffleTweet(id, slotTweetId);
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
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							<img
								src={photo.url}
								width={400}
								height={400}
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
								onLoadStart={() => handleImageLoadStart(photo.id)}
								onLoad={() => handleImageLoad(photo.id)}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slotTweetId && (
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
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							<img
								src={photo.url}
								width={400}
								height={400}
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
								onLoadStart={() => handleImageLoadStart(photo.id)}
								onLoad={() => handleImageLoad(photo.id)}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slotTweetId && (
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
							{/** biome-ignore lint/a11y/useAltText: Fuck off */}
							<img
								src={photo.url}
								width={400}
								height={400}
								className="h-auto w-full transition-transform duration-300 group-hover:scale-105"
								onLoadStart={() => handleImageLoadStart(photo.id)}
								onLoad={() => handleImageLoad(photo.id)}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							{showActions && onDeleteImage && slotTweetId && (
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
}

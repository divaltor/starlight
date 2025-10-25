import type {
	ScheduledSlotData,
	TweetData,
} from "@starlight/api/src/types/tweets";
import { Shuffle, X } from "lucide-react";
import type { UIElementData } from "photoswipe";
import type { PhotoSwipe } from "photoswipe/lightbox";
import { useState } from "react";
import { Gallery, Item } from "react-photoswipe-gallery";
import { Button } from "@/components/ui/button";

type TweetImageGridProps = {
	tweet: TweetData;
	slot?: ScheduledSlotData;
	showActions?: boolean;
	onShuffleTweet?: (tweetId: string) => void;
	onDeleteImage?: (photoId: string) => void;
	showArtistOnHover?: boolean;
};

export function TweetImageGrid({
	tweet,
	slot,
	showActions = false,
	showArtistOnHover = false,
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

	const uiElements: UIElementData[] = [
		{
			name: "download-button",
			ariaLabel: "Download image",
			order: 9,
			isButton: true,
			html: {
				isCustomSVG: true,
				inner: `<path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" id="pswp__icn-download"/>`,
				outlineID: "pswp__icn-download",
			},
			appendTo: "bar",
			onClick: async (
				e: MouseEvent,
				_el: HTMLElement,
				pswpInstance: PhotoSwipe
			) => {
				e.preventDefault();
				const currItem = pswpInstance.currSlide?.data;
				const url = currItem?.src;
				if (!url) {
					return;
				}

				// Extract name from alt (remove extension if present)
				const filename = currItem?.alt ?? "image.jpg";

				try {
					const response = await fetch(url);

					if (!response.ok) {
						throw new Error(`HTTP error! status: ${response.status}`);
					}

					const blob = await response.blob();
					const blobUrl = window.URL.createObjectURL(blob);
					const link = document.createElement("a");
					link.href = blobUrl;
					link.download = filename;
					document.body.appendChild(link);
					link.click();
					document.body.removeChild(link);
					window.URL.revokeObjectURL(blobUrl);
				} catch (error) {
					console.error("Download failed:", error);
				}
			},
		},
	];

	if (tweet.photos.length === 1) {
		const photo = tweet.photos[0];

		return (
			<Gallery
				options={{
					showHideAnimationType: "zoom",
				}}
				uiElements={uiElements}
				withCaption={false}
			>
				<Item
					alt={photo.alt}
					height={photo.height}
					original={photo.url}
					thumbnail={photo.url}
					width={photo.width}
				>
					{({ ref, open }) => (
						<button
							className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md"
							onClick={open}
							ref={ref}
							type="button"
						>
							{isImageLoading[photo.id] && (
								<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
									<div className="loading loading-spinner loading-sm" />
								</div>
							)}
							{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
							<img
								alt={photo.alt}
								className={`${
									photo.is_nsfw ? "blur-sm" : ""
								} h-auto w-full transition-all duration-300 group-hover:scale-105 group-hover:blur-none dark:brightness-80 dark:contrast-105`}
								height={photo.height || 400}
								onLoad={() => handleImageLoad(photo.id, false)}
								onLoadStart={() => handleImageLoad(photo.id, true)}
								src={photo.url}
								width={photo.width || 400}
							/>
							<div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/20" />
							<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent">
								<div className="w-full p-3 text-white">
									<div className="flex items-center justify-between">
										<div
											className={
												showArtistOnHover
													? "pointer-events-none opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100"
													: ""
											}
										>
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
						</button>
					)}
				</Item>
			</Gallery>
		);
	}

	// Multiple images layout with responsive grid
	return (
		<div className="group rounded-box border border-base-200 bg-base-100 p-3 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md">
			{/* Post header */}
			<div className="mb-3 flex items-center justify-between">
				<div
					className={
						showArtistOnHover
							? "pointer-events-none opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100"
							: ""
					}
				>
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
			<Gallery
				options={{
					showHideAnimationType: "zoom",
				}}
				uiElements={uiElements}
				withCaption={false}
			>
				{tweet.photos.length === 2 && (
					<div className="grid grid-cols-2 gap-2">
						{tweet.photos.map((photo) => (
							<Item
								alt={photo.alt}
								height={photo.height}
								key={photo.id}
								original={photo.url}
								thumbnail={photo.url}
								width={photo.width}
							>
								{({ ref, open }) => (
									<button
										className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100"
										onClick={open}
										ref={ref}
										type="button"
									>
										{isImageLoading[photo.id] && (
											<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
												<div className="loading loading-spinner loading-sm" />
											</div>
										)}
										{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
										<img
											alt={photo.alt}
											className={`${
												photo.is_nsfw ? "blur-sm" : ""
											} h-auto w-full transition-all duration-300 group-hover:scale-105 group-hover:blur-none dark:brightness-80 dark:contrast-105`}
											height={photo.height || 400}
											onLoad={() => handleImageLoad(photo.id, false)}
											onLoadStart={() => handleImageLoad(photo.id, true)}
											src={photo.url}
											width={photo.width || 400}
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
									</button>
								)}
							</Item>
						))}
					</div>
				)}
				{tweet.photos.length === 3 && (
					<div className="grid grid-cols-2 gap-2">
						{tweet.photos.map((photo, index) => (
							<Item
								height={photo.height}
								key={photo.id}
								original={photo.url}
								thumbnail={photo.url}
								width={photo.width}
							>
								{({ ref, open }) => (
									<button
										className={`group relative cursor-pointer overflow-hidden rounded-box bg-base-100 ${
											index === 0 ? "col-span-2" : ""
										}`}
										onClick={open}
										ref={ref}
										type="button"
									>
										{isImageLoading[photo.id] && (
											<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
												<div className="loading loading-spinner loading-sm" />
											</div>
										)}
										{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
										<img
											alt={photo.alt}
											className={`${
												photo.is_nsfw ? "blur-sm" : ""
											} h-auto w-full transition-all duration-300 group-hover:scale-105 group-hover:blur-none dark:brightness-80 dark:contrast-105`}
											height={photo.height || 400}
											onLoad={() => handleImageLoad(photo.id, false)}
											onLoadStart={() => handleImageLoad(photo.id, true)}
											src={photo.url}
											width={photo.width || 400}
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
									</button>
								)}
							</Item>
						))}
					</div>
				)}
				{tweet.photos.length === 4 && (
					<div className="grid grid-cols-2 gap-2">
						{tweet.photos.map((photo) => (
							<Item
								height={photo.height}
								key={photo.id}
								original={photo.url}
								thumbnail={photo.url}
								width={photo.width}
							>
								{({ ref, open }) => (
									<button
										className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100"
										onClick={open}
										ref={ref}
										type="button"
									>
										{isImageLoading[photo.id] && (
											<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
												<div className="loading loading-spinner loading-sm" />
											</div>
										)}
										{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fuck off */}
										<img
											alt={photo.alt}
											className={`${
												photo.is_nsfw ? "blur-sm" : ""
											} h-auto w-full transition-all duration-300 group-hover:scale-105 group-hover:blur-none dark:brightness-80 dark:contrast-105`}
											height={photo.height || 400}
											onLoad={() => handleImageLoad(photo.id, false)}
											onLoadStart={() => handleImageLoad(photo.id, true)}
											src={photo.url}
											width={photo.width || 400}
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
									</button>
								)}
							</Item>
						))}
					</div>
				)}
			</Gallery>
		</div>
	);
}

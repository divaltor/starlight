import type { TweetData } from "@starlight/api/src/types/tweets";
import { X } from "lucide-react";
import type { UIElementData } from "photoswipe";
import type { PhotoSwipe } from "photoswipe/lightbox";
import { useState } from "react";
import { Gallery, Item } from "react-photoswipe-gallery";
import { Button } from "@/components/ui/button";
import { Carousel } from "@/components/ui/skiper-ui/carousel";

type TweetImageGridProps = {
	tweet: TweetData;
	showActions?: boolean;
	onDeleteImage?: (photoId: string) => void;
	showArtistOnHover?: boolean;
};

export function TweetImageGrid({
	tweet,
	showActions = false,
	showArtistOnHover = false,
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
						// biome-ignore lint/a11y/useKeyWithClickEvents: don't care
						// biome-ignore lint/a11y/noNoninteractiveElementInteractions: don't care
						// biome-ignore lint/a11y/noStaticElementInteractions: don't care
						<div
							className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md"
							onClick={open}
							ref={ref}
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
										{showActions && onDeleteImage && (
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
								</div>
							</div>
						</div>
					)}
				</Item>
			</Gallery>
		);
	}

	const convertedPhotos = tweet.photos.map((photo) => ({
		src: photo.url,
		alt: photo.alt,
		id: photo.id,
		height: photo.height,
		width: photo.width,
		is_nsfw: photo.is_nsfw,
	}));

	return (
		<Gallery
			options={{
				showHideAnimationType: "zoom",
			}}
			uiElements={uiElements}
			withCaption={false}
		>
			<Carousel
				images={convertedPhotos}
				renderSlide={(item) => (
					<Item
						alt={item.alt}
						height={item.height || 400}
						original={item.src}
						thumbnail={item.src}
						width={item.width || 400}
					>
						{({ ref, open }) => (
							// biome-ignore lint/a11y/useKeyWithClickEvents: don't care
							// biome-ignore lint/a11y/useSemanticElements: don't care
							<div
								className="group relative h-full w-full cursor-pointer overflow-hidden rounded-box transition-all duration-300 hover:z-10"
								onClick={open}
								ref={ref}
								role="button"
								tabIndex={0}
							>
								{isImageLoading[item.id || ""] && (
									<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100/80">
										<div className="loading loading-spinner loading-sm" />
									</div>
								)}
								{/** biome-ignore lint/a11y/noNoninteractiveElementInteractions: don't care */}
								<img
									alt={item.alt}
									className={`${
										item.is_nsfw ? "blur-sm" : ""
									} block h-full w-full object-cover transition-all duration-300 group-hover:scale-105 group-hover:blur-none dark:brightness-80 dark:contrast-105`}
									height={item.height || 400}
									onLoad={() => handleImageLoad(item.id || "", false)}
									onLoadStart={() => handleImageLoad(item.id || "", true)}
									src={item.src}
									width={item.width || 400}
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
													className="cursor-pointer text-left font-medium text-sm drop-shadow-lg transition-colors duration-200 hover:text-primary"
													onClick={(e) => handleArtistClick(e)}
													type="button"
												>
													{tweet.artist}
												</button>
											</div>
											{showActions && onDeleteImage && (
												<Button
													className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md p-0 text-white hover:bg-white/20 hover:text-error"
													onClick={(e) => {
														e.stopPropagation();
														onDeleteImage(item.id || "");
													}}
													size="sm"
													variant="ghost"
												>
													<X className="h-3 w-3" />
												</Button>
											)}
										</div>
									</div>
								</div>
							</div>
						)}
					</Item>
				)}
			/>
		</Gallery>
	);
}

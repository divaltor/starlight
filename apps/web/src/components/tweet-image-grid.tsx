import type { TweetData } from "@starlight/api/src/types/tweets";
import { X } from "lucide-react";
import { useCallback, useState } from "react";
import Lightbox from "yet-another-react-lightbox-lite";
import "yet-another-react-lightbox-lite/styles.css";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Carousel } from "@/components/ui/skiper-ui/carousel";

interface TweetImageGridProps {
	onDeleteImage?: (photoId: string) => void;
	showActions?: boolean;
	showArtistOnHover?: boolean;
	tweet: TweetData;
}

export function TweetImageGrid({
	tweet,
	showActions = false,
	showArtistOnHover = false,
	onDeleteImage,
}: TweetImageGridProps) {
	const [isImageLoading, setIsImageLoading] = useState<{
		[key: string]: boolean;
	}>({});
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const [lightboxIndex, setLightboxIndex] = useState<number>();

	const handleImageLoad = (imageId: string, isLoading: boolean) => {
		setIsImageLoading((prev) => ({ ...prev, [imageId]: isLoading }));
	};

	const handleArtistClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		window.open(tweet.sourceUrl, "_blank", "noopener,noreferrer");
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.currentTarget.click();
		}
	};

	const handleDownload = useCallback(async () => {
		if (lightboxIndex == null) return;
		const photo = tweet.photos[lightboxIndex];
		if (!photo?.url) return;

		try {
			const response = await fetch(photo.url);
			if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
			const blob = await response.blob();
			const blobUrl = window.URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = blobUrl;
			link.download = photo.alt || "image.jpg";
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			window.URL.revokeObjectURL(blobUrl);
		} catch (error) {
			console.error("Download failed:", error);
			window.open(photo.url, "_blank", "noopener,noreferrer");
		}
	}, [lightboxIndex, tweet.photos]);

	// Build lightbox slides from all photos
	const slides = tweet.photos.map((photo) => ({
		src: photo.url,
		alt: photo.alt,
		width: photo.width,
		height: photo.height,
	}));

	const openLightbox = (index: number) => (e?: React.MouseEvent) => {
		e?.stopPropagation();
		setLightboxIndex(index);
	};

	if (tweet.photos.length === 1) {
		const photo = tweet.photos[0];

		return (
			<>
				{/* biome-ignore lint/a11y/useSemanticElements: wrapper must stay a non-button container because it contains nested interactive controls */}
				<div
					className="group relative cursor-pointer overflow-hidden rounded-box bg-base-100 shadow-sm transition-shadow duration-300 will-change-auto hover:shadow-md"
					onClick={openLightbox(0)}
					onKeyDown={handleKeyDown}
					role="button"
					tabIndex={0}
				>
					{isImageLoading[photo.id] && (
						<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100">
							<div className="loading loading-spinner loading-sm" />
						</div>
					)}
					{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: onLoad and onLoadStart are used only for image loading state */}
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
										onClick={handleArtistClick}
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
											setDeleteConfirm(photo.id);
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

				<Lightbox
					carousel={{ preload: 2 }}
					index={lightboxIndex}
					setIndex={setLightboxIndex}
					slides={slides}
					toolbar={{
						buttons: [
							<button
								key="download"
								type="button"
								className="yarll__button"
								aria-label="Download image"
								onClick={handleDownload}
							>
								<svg
									aria-hidden="true"
									className="yarll__icon"
									fill="currentColor"
									viewBox="0 0 32 32"
									xmlns="http://www.w3.org/2000/svg"
								>
									<path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" />
								</svg>
							</button>,
						],
					}}
					zoom={{ maxZoom: 8 }}
				/>

				<DeleteConfirmDialog
					deleteConfirm={deleteConfirm}
					onConfirm={() => {
						if (deleteConfirm) onDeleteImage?.(deleteConfirm);
						setDeleteConfirm(null);
					}}
					onOpenChange={(open) => !open && setDeleteConfirm(null)}
				/>
			</>
		);
	}

	// Multi-image: carousel with separate lightbox open per card
	const convertedPhotos = tweet.photos.map((photo) => ({
		src: photo.url,
		alt: photo.alt,
		id: photo.id,
		height: photo.height,
		width: photo.width,
		is_nsfw: photo.is_nsfw,
	}));

	return (
		<>
			<Carousel
				images={convertedPhotos}
				renderSlide={(item, index) => (
					// biome-ignore lint/a11y/useSemanticElements: wrapper must stay a non-button container because it contains nested interactive controls
					<div
						className="group relative h-full w-full cursor-pointer overflow-hidden rounded-box transition-all duration-300 hover:z-10"
						onClick={openLightbox(index)}
						onKeyDown={handleKeyDown}
						role="button"
						tabIndex={0}
					>
						{isImageLoading[item.id || ""] && (
							<div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100/80">
								<div className="loading loading-spinner loading-sm" />
							</div>
						)}
						{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: onLoad and onLoadStart are used only for image loading state */}
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
											onClick={handleArtistClick}
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
												setDeleteConfirm(item.id || "");
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
			/>

			<Lightbox
				carousel={{ preload: 2 }}
				index={lightboxIndex}
				setIndex={setLightboxIndex}
				slides={slides}
				toolbar={{
					buttons: [
						<button
							key="download"
							type="button"
							className="yarll__button"
							aria-label="Download image"
							onClick={handleDownload}
						>
							<svg
								aria-hidden="true"
								className="yarll__icon"
								fill="currentColor"
								viewBox="0 0 32 32"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" />
							</svg>
						</button>,
					],
				}}
				zoom={{ maxZoom: 8 }}
			/>

			<DeleteConfirmDialog
				deleteConfirm={deleteConfirm}
				onConfirm={() => {
					if (deleteConfirm) onDeleteImage?.(deleteConfirm);
					setDeleteConfirm(null);
				}}
				onOpenChange={(open) => !open && setDeleteConfirm(null)}
			/>
		</>
	);
}

function DeleteConfirmDialog({
	deleteConfirm,
	onConfirm,
	onOpenChange,
}: {
	deleteConfirm: string | null;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<AlertDialog open={deleteConfirm !== null} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete image</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to delete this image? This action cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={onConfirm}>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

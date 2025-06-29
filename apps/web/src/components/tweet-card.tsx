"use client";

import { Calendar, Trash2 } from "lucide-react";
import { ImageCard } from "@/components/image-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface TweetPhoto {
	id: string;
	url: string;
}

interface TweetCardProps {
	author: string;
	createdAt?: Date;
	photos: TweetPhoto[];
	onDeleteImage?: (photoId: string) => void;
	onReshuffleImage?: (photoId: string) => void;
	readonly?: boolean;
	compact?: boolean;
	className?: string;
}

export function TweetCard({
	author,
	createdAt,
	photos,
	onDeleteImage,
	onReshuffleImage,
	readonly = false,
	compact = false,
	className = "",
}: TweetCardProps) {
	const formatDate = (date: Date) => {
		return new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		}).format(date);
	};

	if (compact) {
		return (
			<Card className={`overflow-hidden h-full ${className}`}>
				<CardContent className="p-3">
					{/* Compact header */}
					<div className="flex items-center justify-between gap-2 mb-3">
						<div className="flex items-center gap-1 min-w-0">
							<span className="font-medium text-gray-700 text-xs truncate">
								@{author}
							</span>
							{createdAt && (
								<>
									<span className="text-gray-300 text-xs">•</span>
									<span className="text-gray-400 text-xs whitespace-nowrap">
										{formatDate(createdAt)}
									</span>
								</>
							)}
						</div>
						{!readonly && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => console.log("Remove tweet from slot")}
								className="h-6 w-6 p-0 flex-shrink-0 flex items-center justify-center text-red-600 hover:text-red-700 hover:bg-red-50"
							>
								<Trash2 className="h-3 w-3" />
							</Button>
						)}
					</div>

					{/* Compact images grid */}
					{photos.length > 0 && (
						<div className="grid grid-cols-2 gap-1">
							{photos.slice(0, 4).map((photo, index) => (
								<ImageCard
									key={photo.id}
									src={photo.url}
									alt={`Tweet image ${index + 1}`}
									index={index}
									canDelete={!readonly && photos.length > 1}
									onDelete={
										onDeleteImage && !readonly
											? () => onDeleteImage(photo.id)
											: () => {}
									}
									onReshuffle={
										onReshuffleImage && !readonly
											? () => onReshuffleImage(photo.id)
											: () => {}
									}
								/>
							))}
							{photos.length > 4 && (
								<div className="flex items-center justify-center bg-gray-100 rounded text-gray-500 text-xs">
									+{photos.length - 4}
								</div>
							)}
						</div>
					)}
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className={`overflow-hidden ${className}`}>
			<CardHeader className="pb-2 pt-3">
				<div className="flex items-center justify-between gap-3">
					<div className="flex flex-1 items-center gap-2 min-w-0">
						{/* Tweet Info */}
						<div className="flex items-center gap-2 min-w-0">
							<span className="font-medium text-gray-700 text-sm truncate">
								@{author}
							</span>
							{createdAt && (
								<>
									<span className="text-gray-300">•</span>
									<div className="flex items-center gap-1">
										<Calendar className="h-3 w-3 text-gray-400 flex-shrink-0" />
										<span className="text-gray-400 text-xs whitespace-nowrap">
											{formatDate(createdAt)}
										</span>
									</div>
								</>
							)}
						</div>
					</div>

					{/* Trash button */}
					{!readonly && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => console.log("Remove tweet from slot")}
							className="h-7 w-7 p-0 flex-shrink-0 flex items-center justify-center rounded-full text-red-600 hover:text-red-700 hover:bg-red-50"
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					)}
				</div>
			</CardHeader>

			<CardContent className="pt-0 pb-3">
				{/* Images Grid */}
				{photos.length > 0 && (
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
						{photos.map((photo, index) => (
							<ImageCard
								key={photo.id}
								src={photo.url}
								alt={`Tweet image ${index + 1}`}
								index={index}
								canDelete={!readonly && photos.length > 1}
								onDelete={
									onDeleteImage && !readonly
										? () => onDeleteImage(photo.id)
										: () => {}
								}
								onReshuffle={
									onReshuffleImage && !readonly
										? () => onReshuffleImage(photo.id)
										: () => {}
								}
							/>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

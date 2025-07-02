"use client";

import { Calendar, Shuffle, Trash2 } from "lucide-react";
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
	onShuffleTweet?: () => void;
	readonly?: boolean;
	compact?: boolean;
	className?: string;
}

export function TweetCard({
	author,
	createdAt,
	photos,
	onDeleteImage,
	onShuffleTweet,
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
			<Card className={`h-full overflow-hidden ${className}`}>
				<CardContent className="p-3">
					{/* Compact header */}
					<div className="mb-3 flex items-center justify-between gap-2">
						<div className="flex min-w-0 items-center gap-1">
							<span className="truncate font-medium text-gray-700 text-xs">
								@{author}
							</span>
							{createdAt && (
								<>
									<span className="text-gray-300 text-xs">•</span>
									<span className="whitespace-nowrap text-gray-400 text-xs">
										{formatDate(createdAt)}
									</span>
								</>
							)}
						</div>
						{!readonly && (
							<div className="flex items-center gap-1">
								{onShuffleTweet && (
									<Button
										variant="ghost"
										size="sm"
										onClick={onShuffleTweet}
										className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-blue-600 hover:bg-blue-50 hover:text-blue-700"
									>
										<Shuffle className="h-3 w-3" />
									</Button>
								)}
								<Button
									variant="ghost"
									size="sm"
									onClick={() => console.log("Remove tweet from slot")}
									className="flex h-6 w-6 flex-shrink-0 items-center justify-center p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
								>
									<Trash2 className="h-3 w-3" />
								</Button>
							</div>
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
								/>
							))}
							{photos.length > 4 && (
								<div className="flex items-center justify-center rounded bg-gray-100 text-gray-500 text-xs">
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
			<CardHeader className="pt-3 pb-2">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 flex-1 items-center gap-2">
						{/* Tweet Info */}
						<div className="flex min-w-0 items-center gap-2">
							<span className="truncate font-medium text-gray-700 text-sm">
								@{author}
							</span>
							{createdAt && (
								<>
									<span className="text-gray-300">•</span>
									<div className="flex items-center gap-1">
										<Calendar className="h-3 w-3 flex-shrink-0 text-gray-400" />
										<span className="whitespace-nowrap text-gray-400 text-xs">
											{formatDate(createdAt)}
										</span>
									</div>
								</>
							)}
						</div>
					</div>

					{/* Action buttons */}
					{!readonly && (
						<div className="flex items-center gap-1">
							{onShuffleTweet && (
								<Button
									variant="ghost"
									size="sm"
									onClick={onShuffleTweet}
									className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full p-0 text-blue-600 hover:bg-blue-50 hover:text-blue-700"
								>
									<Shuffle className="h-4 w-4" />
								</Button>
							)}
							<Button
								variant="ghost"
								size="sm"
								onClick={() => console.log("Remove tweet from slot")}
								className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
							>
								<Trash2 className="h-4 w-4" />
							</Button>
						</div>
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
							/>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

"use client";

import { Calendar, MessageSquare, MoreVertical, User } from "lucide-react";
import { useState } from "react";
import { ImageCard } from "@/components/image-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TweetPhoto {
	id: string;
	url: string;
}

interface TweetCardProps {
	author: string;
	text?: string;
	createdAt?: Date;
	photos: TweetPhoto[];
	onDeleteImage?: (photoId: string) => void;
	onReshuffleImage?: (photoId: string) => void;
	readonly?: boolean;
	className?: string;
}

export function TweetCard({
	author,
	text,
	createdAt,
	photos,
	onDeleteImage,
	onReshuffleImage,
	readonly = false,
	className = "",
}: TweetCardProps) {
	const [isPressed, setIsPressed] = useState(false);

	const formatDate = (date: Date) => {
		return new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		}).format(date);
	};

	return (
		<Card
			className={`overflow-hidden transition-transform duration-150 ${
				isPressed ? "scale-98" : "scale-100"
			} ${className}`}
			onTouchStart={() => setIsPressed(true)}
			onTouchEnd={() => setIsPressed(false)}
			onMouseDown={() => setIsPressed(true)}
			onMouseUp={() => setIsPressed(false)}
			onMouseLeave={() => setIsPressed(false)}
		>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-1 flex-col gap-2">
						{/* Tweet Info */}
						<div className="flex flex-wrap items-center gap-2">
							<div className="flex items-center gap-1">
								<User className="h-3 w-3 text-gray-500" />
								<span className="font-medium text-gray-700 text-sm">
									@{author}
								</span>
							</div>
							{createdAt && (
								<div className="flex items-center gap-1">
									<Calendar className="h-3 w-3 text-gray-400" />
									<span className="text-gray-400 text-xs">
										{formatDate(createdAt)}
									</span>
								</div>
							)}
						</div>

						{/* Tweet Text */}
						{text && (
							<p className="line-clamp-2 text-gray-600 text-sm">{text}</p>
						)}

						{/* Photo Count */}
						<div className="flex items-center gap-2">
							<span className="text-gray-500 text-xs">
								{photos.length} photo{photos.length !== 1 ? "s" : ""}
							</span>
						</div>
					</div>

					{/* Mobile dropdown menu */}
					{!readonly && (
						<div className="md:hidden">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" size="sm" className="h-8 w-8 p-0">
										<MoreVertical className="h-4 w-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-40">
									<DropdownMenuItem
										onClick={() => console.log("Remove tweet from slot")}
										className="gap-2 text-red-600 focus:text-red-600"
									>
										Remove Tweet
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					)}
				</div>
			</CardHeader>

			<CardContent className="pt-0">
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

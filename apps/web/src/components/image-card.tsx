"use client";

import { MoreVertical, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ImageCardProps = {
	src: string;
	alt: string;
	index: number;
	canDelete: boolean;
	onDelete: (index: number) => void;
	sourceUrl?: string;
};

export function ImageCard({
	src,
	alt,
	index,
	canDelete,
	onDelete,
	sourceUrl,
}: ImageCardProps) {
	const [isPressed, setIsPressed] = useState(false);

	return (
		<button
			className={`group relative aspect-square overflow-hidden rounded-lg bg-gray-100 transition-transform duration-150 ${
				isPressed ? "scale-95" : "scale-100"
			}`}
			onClick={() => {
				if (sourceUrl) {
					window.open(sourceUrl, "_blank", "noopener,noreferrer");
				}
			}}
			onMouseDown={() => setIsPressed(true)}
			onMouseLeave={() => setIsPressed(false)}
			onMouseUp={() => setIsPressed(false)}
			onTouchEnd={() => setIsPressed(false)}
			onTouchStart={() => setIsPressed(true)}
			type="button"
		>
			{/** biome-ignore lint/nursery/useImageSize: We need to set the width and height of the image */}
			<img
				alt={alt}
				className="object-cover"
				src={src || "/placeholder.svg"}
				style={{ width: "100%", height: "100%" }}
			/>

			{/* Desktop hover controls */}
			{canDelete && (
				<div className="absolute inset-0 hidden items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100 md:flex">
					<Button
						className="bg-white/90 text-red-600 hover:bg-white hover:text-red-700"
						onClick={(e) => {
							e.stopPropagation();
							onDelete(index);
						}}
						size="sm"
						variant="secondary"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			)}

			{/* Mobile dropdown menu */}
			{canDelete && (
				<div className="absolute top-2 right-2 md:hidden">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								className="h-8 w-8 border-0 bg-black/70 p-0 text-white hover:bg-black/80"
								size="sm"
								variant="secondary"
							>
								<MoreVertical className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-40">
							<DropdownMenuItem
								className="gap-2 text-red-600 focus:text-red-600"
								onClick={(e) => {
									e.stopPropagation();
									onDelete(index);
								}}
							>
								<Trash2 className="h-4 w-4" />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}

			{/* Image index indicator */}
			<div className="absolute bottom-2 left-2">
				<div className="rounded bg-black/70 px-2 py-1 text-white text-xs">
					{index + 1}
				</div>
			</div>
		</button>
	);
}

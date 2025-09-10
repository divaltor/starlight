import { useMemo } from "react";
import type { CollectionShare } from "@/routes/api/share-collections";

interface CollectionCardProps {
	collection: CollectionShare;
	tweets?: { id: string; photo: string }[]; // optional preview photo URLs
	onClick?: () => void;
}

export function CollectionCard({
	collection,
	tweets = [],
	onClick,
}: CollectionCardProps) {
	const limited = useMemo(() => tweets.slice(0, 4), [tweets]);

	if (limited.length === 0) {
		return (
			<div
				className="flex h-40 cursor-pointer flex-col justify-between rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md"
				onClick={onClick}
			>
				<div>
					<p className="line-clamp-1 font-medium text-gray-900 text-sm">
						{collection.name || "Untitled"}
					</p>
				</div>
				<div className="flex items-center justify-between text-gray-500 text-xs">
					<span>{collection.tweetCount} tweets</span>
					<span>{collection.authorCount} authors</span>
				</div>
			</div>
		);
	}

	return (
		<div
			className="cursor-pointer overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md"
			onClick={onClick}
		>
			<div className="grid grid-cols-2 gap-0.5">
				{limited.map((tweet, i) => (
					<div
						key={tweet.id}
						className="relative aspect-square overflow-hidden bg-gray-100"
					>
						{/** biome-ignore lint/a11y/useAltText: decorative */}
						<img
							src={tweet.photo}
							className="h-full w-full object-cover transition-transform duration-300 hover:scale-105"
						/>
					</div>
				))}
			</div>
			<div className="flex items-center justify-between p-2">
				<p className="line-clamp-1 font-medium text-gray-900 text-xs">
					{collection.name || "Untitled"}
				</p>
				<div className="flex items-center gap-1 text-[10px] text-gray-500">
					<span>{collection.tweetCount} tweets</span>
					<span>·</span>
					<span>{collection.authorCount} authors</span>
				</div>
			</div>
		</div>
	);
}

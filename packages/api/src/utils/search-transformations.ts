import { format } from "date-fns";
import type { SearchResult, TweetData } from "../types/tweets";

export const transformSearchResultsPure = (
	results: SearchResult[],
	baseCdnUrl: string,
): TweetData[] => {
	const grouped = new Map<
		string,
		{
			id: string;
			provider: string;
			username: string;
			sourceUrl: string;
			createdAt: Date;
			photos: Array<{
				id: string;
				provider: string;
				originalUrl: string;
				s3Url?: string;
				isNsfw?: boolean;
				height?: number;
				width?: number;
			}>;
		}
	>();
	for (const result of results) {
		const key = `${result.post_provider}:${result.tweet_id}`;
		let post = grouped.get(key);
		if (!post) {
			post = {
				id: result.tweet_id,
				provider: result.post_provider,
				username: result.username,
				sourceUrl: result.source_url,
				createdAt: result.tweet_created_at,
				photos: [],
			};
			grouped.set(key, post);
		}
		post.photos.push({
			id: result.photo_id,
			provider: result.provider,
			originalUrl: result.original_url,
			s3Url: result.s3_path ? `${baseCdnUrl}/${result.s3_path}` : undefined,
			isNsfw: result.is_nsfw,
			height: result.height,
			width: result.width,
		});
	}
	return Array.from(grouped.values(), (post) => {
		const photos = post.photos.map((photo) => ({
			id: photo.provider === "twitter" ? photo.id : `${photo.provider}:${photo.id}`,
			externalId: photo.id,
			provider: photo.provider,
			url: photo.s3Url ?? photo.originalUrl,
			is_nsfw: photo.isNsfw,
			height: photo.height,
			width: photo.width,
			alt: `${post.username}-${photo.id}.${photo.originalUrl.split(".").pop() ?? "jpg"}`,
		}));
		return {
			id: post.provider === "twitter" ? post.id : `${post.provider}:${post.id}`,
			externalId: post.id,
			provider: post.provider,
			artist: post.username ? `@${post.username}` : "@good_artist",
			date: format(post.createdAt, "MMM d, yyyy"),
			photos,
			hasMultipleImages: photos.length > 1,
			sourceUrl: post.sourceUrl,
		};
	});
};

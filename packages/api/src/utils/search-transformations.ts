import { format } from "date-fns";
import type { SearchResult, TweetData } from "../types/tweets";
import { createPublicId } from "./public-id";

export const transformSearchResultsPure = (
	results: SearchResult[],
	baseCdnUrl: string,
): TweetData[] => {
	const grouped = new Map<
		string,
		{
			id: string;
			provider: string;
			userId: string;
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
		const key = JSON.stringify([result.post_provider, result.post_id, result.user_id]);
		let post = grouped.get(key);
		if (!post) {
			post = {
				id: result.post_id,
				provider: result.post_provider,
				userId: result.user_id,
				username: result.username,
				sourceUrl: result.source_url,
				createdAt: result.post_created_at,
				photos: [],
			};
			grouped.set(key, post);
		}
		post.photos.push({
			id: result.media_id,
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
			id: createPublicId("media", photo.provider, photo.id, post.userId),
			externalId: photo.id,
			provider: photo.provider,
			url: photo.s3Url ?? photo.originalUrl,
			is_nsfw: photo.isNsfw,
			height: photo.height,
			width: photo.width,
			alt: `${post.username}-${photo.id}.${photo.originalUrl.split(".").pop() ?? "jpg"}`,
		}));
		return {
			id: createPublicId("post", post.provider, post.id, post.userId),
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

import { format } from "date-fns";
import type { PostData, SearchResult } from "../types/posts";
import { createPublicId } from "./public-id";

export const transformSearchResultsPure = (
	results: SearchResult[],
	baseCdnUrl: string,
): PostData[] => {
	const grouped = new Map<
		string,
		{
			id: string;
			provider: string;
			userId: string;
			username: string;
			sourceUrl: string;
			createdAt: Date;
			media: Array<{
				id: string;
				kind: string;
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
				media: [],
			};
			grouped.set(key, post);
		}
		post.media.push({
			id: result.media_id,
			kind: result.kind,
			provider: result.provider,
			originalUrl: result.original_url,
			s3Url: result.s3_path ? `${baseCdnUrl}/${result.s3_path}` : undefined,
			isNsfw: result.is_nsfw,
			height: result.height,
			width: result.width,
		});
	}
	return Array.from(grouped.values(), (post) => {
		const media = post.media.map((item) => ({
			id: createPublicId("media", item.provider, item.id, post.userId),
			externalId: item.id,
			kind: item.kind,
			provider: item.provider,
			url: item.s3Url ?? item.originalUrl,
			is_nsfw: item.isNsfw,
			height: item.height,
			width: item.width,
			alt: `${post.username}-${item.id}.${item.originalUrl.split(".").pop() ?? "jpg"}`,
		}));
		return {
			id: createPublicId("post", post.provider, post.id, post.userId),
			externalId: post.id,
			provider: post.provider,
			artist: post.username ? `@${post.username}` : "@good_artist",
			date: format(post.createdAt, "MMM d, yyyy"),
			media,
			hasMultipleMedia: media.length > 1,
			sourceUrl: post.sourceUrl,
		};
	});
};

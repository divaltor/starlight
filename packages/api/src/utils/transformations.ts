import type { Media, Post } from "@starlight/utils";
import { format } from "date-fns";
import type { PostData, SearchResult } from "../types/posts";
import { createPublicId } from "./public-id";
import { transformSearchResultsPure } from "./search-transformations";

type TransformMedia = Pick<Media, "id" | "kind" | "originalUrl" | "provider"> & {
	s3Url?: string;
	is_nsfw?: boolean;
	height?: number | null;
	width?: number | null;
};

type TransformPost = Pick<
	Post,
	"authorUsername" | "createdAt" | "id" | "provider" | "sourceUrl" | "userId" | "username"
>;

const transformPostsBase = <T extends TransformPost>(
	posts: T[],
	getMedia: (post: T) => TransformMedia[],
): PostData[] =>
	posts.map((post) => {
		const artist = post.authorUsername ?? post.username;
		const media = getMedia(post).map((item) => ({
			id: createPublicId("media", item.provider, item.id, post.userId),
			externalId: item.id,
			provider: item.provider,
			kind: item.kind,
			url: item.s3Url ?? item.originalUrl,
			is_nsfw: item.is_nsfw,
			height: item.height ?? undefined,
			width: item.width ?? undefined,
			alt: `${artist ?? "artist"}-${item.id}.${item.originalUrl.split(".").at(-1) ?? "jpg"}`,
		}));
		return {
			id: createPublicId("post", post.provider, post.id, post.userId),
			externalId: post.id,
			provider: post.provider,
			artist: artist ? `@${artist}` : "@good_artist",
			date: format(post.createdAt, "MMM d, yyyy"),
			media,
			hasMultipleMedia: media.length > 1,
			sourceUrl: post.sourceUrl,
		};
	});

export const transformPosts = (
	posts: Array<TransformPost & { media: Array<TransformMedia & { s3Url?: string }> }>,
) => transformPostsBase(posts, (post) => post.media);

export const transformSearchResults = (results: SearchResult[], baseCdnUrl: string) =>
	transformSearchResultsPure(results, baseCdnUrl);

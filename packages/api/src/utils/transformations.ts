import type { Media, Post } from "@starlight/utils";
import { format } from "date-fns";
import type { TweetData } from "../types/tweets";
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

const transformTweetsBase = <T extends TransformPost>(
	posts: T[],
	getMedia: (post: T) => TransformMedia[],
): TweetData[] =>
	posts.map((post) => {
		const artist = post.authorUsername ?? post.username;
		const photos = getMedia(post).map((media) => ({
			id: createPublicId("media", media.provider, media.id, post.userId),
			externalId: media.id,
			provider: media.provider,
			kind: media.kind,
			url: media.s3Url ?? media.originalUrl,
			is_nsfw: media.is_nsfw,
			height: media.height ?? undefined,
			width: media.width ?? undefined,
			alt: `${artist ?? "artist"}-${media.id}.${media.originalUrl.split(".").at(-1) ?? "jpg"}`,
		}));
		return {
			id: createPublicId("post", post.provider, post.id, post.userId),
			externalId: post.id,
			provider: post.provider,
			artist: artist ? `@${artist}` : "@good_artist",
			date: format(post.createdAt, "MMM d, yyyy"),
			photos,
			hasMultipleImages: photos.length > 1,
			sourceUrl: post.sourceUrl,
		};
	});

export const transformTweets = (
	posts: Array<TransformPost & { photos: Array<TransformMedia & { s3Url?: string }> }>,
) => transformTweetsBase(posts, (post) => post.photos);

export const transformSearchResults = (
	results: import("../types/tweets").SearchResult[],
	baseCdnUrl: string,
) => transformSearchResultsPure(results, baseCdnUrl);

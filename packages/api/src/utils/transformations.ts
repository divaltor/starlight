import { env, type Photo, type Tweet } from "@starlight/utils";
import { format } from "date-fns";
import type { SearchResult, TweetData } from "../types/tweets";

function transformTweetsBase<T extends Pick<Tweet, "id" | "createdAt" | "username">>(
	tweets: T[],
	getPhotos: (tweet: T) => Array<
		Pick<Photo, "id" | "originalUrl"> & {
			s3Url?: string;
			is_nsfw?: boolean;
			height?: number;
			width?: number;
		}
	>,
): TweetData[] {
	return tweets.map((tweet) => {
		const photos = getPhotos(tweet).map((photo) => {
			const extension = photo.originalUrl.split(".").pop() ?? "jpg";

			return {
				id: photo.id,
				url: photo.s3Url || photo.originalUrl,
				is_nsfw: photo.is_nsfw,
				height: photo.height,
				width: photo.width,
				alt: `${tweet.username}-${photo.id}.${extension}`,
			};
		});

		return {
			id: tweet.id,
			artist: tweet.username ? `@${tweet.username}` : "@good_artist",
			date: format(tweet.createdAt, "MMM d, yyyy"),
			photos,
			hasMultipleImages: photos.length > 1,
			sourceUrl: `https://x.com/i/status/${tweet.id}`,
		};
	});
}

export const transformTweets = (
	tweets: (Tweet & {
		photos: (Photo & {
			s3Url: string | undefined;
			height?: number;
			width?: number;
		})[];
	})[],
) => transformTweetsBase(tweets, (t) => t.photos);

export const transformSearchResults = (results: SearchResult[]): TweetData[] => {
	const grouped = results.reduce(
		(acc, result) => {
			const tweetId = result.tweet_id;
			if (!acc[tweetId]) {
				acc[tweetId] = {
					id: tweetId,
					username: result.username,
					createdAt: result.tweet_created_at,
					photos: [],
				};
			}
			acc[tweetId].photos.push({
				id: result.photo_id,
				originalUrl: result.original_url,
				s3Url: result.s3_path ? `${env.BASE_CDN_URL}/${result.s3_path}` : undefined,
				is_nsfw: result.is_nsfw,
				height: result.height,
				width: result.width,
			});
			return acc;
		},
		{} as Record<
			string,
			{
				id: string;
				username: string;
				createdAt: Date;
				photos: Array<{
					id: string;
					originalUrl: string;
					s3Url?: string;
					is_nsfw?: boolean;
					height?: number;
					width?: number;
				}>;
			}
		>,
	);

	return transformTweetsBase(Object.values(grouped), (tweet) => tweet.photos);
};

import {
	env,
	type Photo,
	type ScheduledSlot,
	type ScheduledSlotPhoto,
	type ScheduledSlotTweet,
	type Tweet,
} from "@starlight/utils";
import { format } from "date-fns";
import type {
	ScheduledSlotData,
	SearchResult,
	TweetData,
} from "../types/tweets";

function transformTweetsBase<
	T extends Pick<Tweet, "id" | "createdAt" | "username">,
>(
	tweets: T[],
	getPhotos: (tweet: T) => Array<
		Pick<Photo, "id" | "originalUrl"> & {
			s3Url?: string;
			is_nsfw?: boolean;
			height?: number;
			width?: number;
		}
	>
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
	})[]
) => transformTweetsBase(tweets, (t) => t.photos);

export const transformSlotTweets = (
	tweets: (ScheduledSlotTweet & { tweet: Tweet } & {
		scheduledSlotPhotos: (ScheduledSlotPhoto & {
			photo: Photo & {
				s3Url: string | undefined;
				height?: number;
				width?: number;
			};
		})[];
	})[]
) => {
	const transformedTweets = tweets.map((t) => ({
		...t.tweet,
		scheduledSlotPhotos: t.scheduledSlotPhotos.map((s) => s.photo),
	}));
	return transformTweetsBase(transformedTweets, (t) => t.scheduledSlotPhotos);
};

export const transformScheduledSlot = (
	slot: ScheduledSlot & {
		postingChannel: {
			chat: { title: string | null; username: string | null };
		};
	}
): ScheduledSlotData => ({
	id: slot.id,
	status: slot.status,
	chat: {
		title: slot.postingChannel.chat.title || undefined,
		username: slot.postingChannel.chat.username || undefined,
	},
});

export const transformSearchResults = (
	results: SearchResult[]
): TweetData[] => {
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
				s3Url: result.s3_path
					? `${env.BASE_CDN_URL}/${result.s3_path}`
					: undefined,
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
		>
	);

	return transformTweetsBase(Object.values(grouped), (tweet) => tweet.photos);
};

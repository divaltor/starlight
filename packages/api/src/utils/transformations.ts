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
	getPhotos: (
		tweet: T
	) => Array<Pick<Photo, "id" | "originalUrl"> & { s3Url: string | undefined }>
): TweetData[] {
	return tweets.map((tweet) => {
		const photos = getPhotos(tweet).map((photo) => ({
			id: photo.id,
			url: photo.s3Url || photo.originalUrl,
		}));

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
	tweets: (Tweet & { photos: (Photo & { s3Url: string | undefined })[] })[]
) => transformTweetsBase(tweets, (t) => t.photos);

export const transformSlotTweets = (
	tweets: (ScheduledSlotTweet & { tweet: Tweet } & {
		scheduledSlotPhotos: (ScheduledSlotPhoto & {
			photo: Photo & { s3Url: string | undefined };
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

export const transformSearchResults = (results: SearchResult[]): TweetData[] =>
	transformTweetsBase(
		results.map((result) => ({
			id: result.tweetId,
			username: result.artist,
			createdAt: result.tweetCreatedAt,
			photos: [
				{
					id: result.id,
					originalUrl: result.originalUrl,
					s3Url: result.s3Path
						? `${env.BASE_CDN_URL}/${result.s3Path}`
						: undefined,
				},
			],
		})),
		(result) => result.photos
	);

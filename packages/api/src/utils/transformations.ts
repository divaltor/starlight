import type {
	Photo,
	ScheduledSlotPhoto,
	ScheduledSlotTweet,
	Tweet,
} from "@starlight/utils";
import type { TweetData } from "../types/tweets";

function transformTweetsBase<T extends Tweet>(
	tweets: T[],
	getPhotos: (tweet: T) => Array<Photo & { s3Url: string | undefined }>
): TweetData[] {
	return tweets.map((tweet) => {
		const photos = getPhotos(tweet).map((photo) => ({
			id: photo.id,
			url: photo.s3Url || photo.originalUrl,
		}));

		const tweetData = tweet.tweetData;
		const tweetUsername = tweetData?.username;

		return {
			id: tweet.id,
			artist: tweetUsername ? `@${tweetUsername}` : "@good_artist",
			date: tweet.createdAt.toISOString(),
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

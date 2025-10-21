import type { ScheduledSlotStatus } from "@starlight/utils";

export type SearchResult = {
	id: string;
	originalUrl: string;
	s3Path: string;
	artist: string;
	tweetId: string;
	tweetCreatedAt: Date;
};

export type PhotoData = {
	id: string;
	url: string;
};

export type TweetData = {
	id: string;
	artist: string;
	date: string;
	photos: PhotoData[];
	hasMultipleImages: boolean;
	sourceUrl?: string;
};

export type ScheduledSlotData = {
	id: string;
	status: ScheduledSlotStatus;
	chat: {
		title?: string;
		username?: string;
	};
};

export type ScheduledSlotResult = {
	slot: ScheduledSlotData | null;
	tweets: TweetData[];
};

export type TweetsPageResult = {
	tweets: TweetData[];
	nextCursor: string | null;
};

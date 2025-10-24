import type { ScheduledSlotStatus } from "@starlight/utils";

export type SearchResult = {
	photo_id: string;
	original_url: string;
	s3_path: string;
	username: string;
	tweet_id: string;
	tweet_created_at: Date;
	is_nsfw: boolean;
};

export type PhotoData = {
	id: string;
	url: string;
	is_nsfw?: boolean;
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

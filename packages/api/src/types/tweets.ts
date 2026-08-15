export type SearchResult = {
	photo_id: string;
	provider: string;
	kind?: string;
	original_url: string;
	s3_path: string;
	username: string;
	tweet_id: string;
	post_provider: string;
	source_url: string;
	tweet_created_at: Date;
	is_nsfw: boolean;
	height: number;
	width: number;
	final_score: number;
};

export type PhotoData = {
	id: string;
	externalId: string;
	provider: string;
	kind?: string;
	url: string;
	is_nsfw?: boolean;
	height?: number;
	width?: number;
	alt: string;
};

export type TweetData = {
	id: string;
	externalId: string;
	provider: string;
	artist: string;
	date: string;
	photos: PhotoData[];
	hasMultipleImages: boolean;
	sourceUrl?: string;
};

export type TweetsPageResult = {
	tweets: TweetData[];
	nextCursor: string | null;
};

export type SearchPageResult = {
	results: TweetData[];
	nextCursor: string | null;
};

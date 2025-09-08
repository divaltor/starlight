export interface PhotoData {
	id: string;
	url: string;
}

export interface TweetData {
	id: string;
	artist: string;
	date: string;
	photos: PhotoData[];
	hasMultipleImages: boolean;
	sourceUrl?: string;
}

export interface TweetsPageResult {
	tweets: TweetData[];
	nextCursor: string | null;
}

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

export type TweetsPageResult = {
	tweets: TweetData[];
	nextCursor: string | null;
};

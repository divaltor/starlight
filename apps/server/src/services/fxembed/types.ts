export type FxEmbedAuthor = {
	id: string;
	name: string;
	screen_name: string;
	avatar_url: string;
};

export type FxEmbedPhoto = {
	type: "photo";
	url: string;
	width: number;
	height: number;
};

export type FxEmbedVideo = {
	type: "video" | "gif";
	url: string;
	thumbnail_url: string;
	width: number;
	height: number;
};

export type FxEmbedMedia = {
	photos?: FxEmbedPhoto[];
	videos?: FxEmbedVideo[];
};

export type FxEmbedTweet = {
	id: string;
	url: string;
	text: string;
	created_at: string;
	created_timestamp: number;
	author: FxEmbedAuthor;
	likes: number;
	retweets: number;
	replies: number;
	views?: number;
	media?: FxEmbedMedia;
	quote?: FxEmbedTweet;
};

export type FxEmbedResponse = {
	code: number;
	message: string;
	tweet?: FxEmbedTweet;
};

export type FxEmbedErrorCode = 401 | 404 | 500;
export type FxEmbedErrorMessage = "PRIVATE_TWEET" | "NOT_FOUND" | "API_FAIL";

export type FxEmbedError = {
	code: FxEmbedErrorCode;
	message: FxEmbedErrorMessage;
};

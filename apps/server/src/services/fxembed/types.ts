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

export type FxEmbedArticleCoverMedia = {
	media_key: string;
	media_id: string;
	media_info: {
		__typename: "ApiImage";
		original_img_height: number;
		original_img_width: number;
		original_img_url: string;
	};
};

export type FxEmbedArticle = {
	title: string;
	preview_text: string;
	cover_media?: FxEmbedArticleCoverMedia;
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
	article?: FxEmbedArticle;
	quote?: FxEmbedTweet;
	replying_to?: string | null;
	replying_to_status?: string | null;
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

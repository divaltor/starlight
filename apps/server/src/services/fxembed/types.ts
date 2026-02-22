export interface FxEmbedAuthor {
	avatar_url: string;
	id: string;
	name: string;
	screen_name: string;
}

export interface FxEmbedPhoto {
	height: number;
	type: "photo";
	url: string;
	width: number;
}

export interface FxEmbedVideo {
	height: number;
	thumbnail_url: string;
	type: "video" | "gif";
	url: string;
	width: number;
}

export interface FxEmbedMedia {
	photos?: FxEmbedPhoto[];
	videos?: FxEmbedVideo[];
}

export interface FxEmbedArticleCoverMedia {
	media_id: string;
	media_info: {
		__typename: "ApiImage";
		original_img_height: number;
		original_img_width: number;
		original_img_url: string;
	};
	media_key: string;
}

export interface FxEmbedArticle {
	cover_media?: FxEmbedArticleCoverMedia;
	preview_text: string;
	title: string;
}

export interface FxEmbedTweet {
	article?: FxEmbedArticle;
	author: FxEmbedAuthor;
	created_at: string;
	created_timestamp: number;
	id: string;
	likes: number;
	media?: FxEmbedMedia;
	quote?: FxEmbedTweet;
	replies: number;
	replying_to?: string | null;
	replying_to_status?: string | null;
	retweets: number;
	text: string;
	url: string;
	views?: number;
}

export interface FxEmbedResponse {
	code: number;
	message: string;
	tweet?: FxEmbedTweet;
}

export type FxEmbedErrorCode = 401 | 404 | 500;
export type FxEmbedErrorMessage = "PRIVATE_TWEET" | "NOT_FOUND" | "API_FAIL";

export interface FxEmbedError {
	code: FxEmbedErrorCode;
	message: FxEmbedErrorMessage;
}

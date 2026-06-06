import { Schema } from "effect";
import type { ArticleData, TweetData } from "@/services/render";

export const FxEmbedAuthorSchema = Schema.Struct({
	avatar_url: Schema.String,
	id: Schema.String,
	name: Schema.String,
	screen_name: Schema.String,
});
export type FxEmbedAuthor = typeof FxEmbedAuthorSchema.Type;

export const FxEmbedPhotoSchema = Schema.Struct({
	height: Schema.Number,
	type: Schema.Literal("photo"),
	url: Schema.String,
	width: Schema.Number,
});
export type FxEmbedPhoto = typeof FxEmbedPhotoSchema.Type;

export const FxEmbedMosaicPhotoSchema = Schema.Struct({
	formats: Schema.Struct({
		jpeg: Schema.String,
		webp: Schema.String,
	}),
	height: Schema.optional(Schema.Number),
	type: Schema.Literal("mosaic_photo"),
	url: Schema.optional(Schema.String),
	width: Schema.optional(Schema.Number),
});
export type FxEmbedMosaicPhoto = typeof FxEmbedMosaicPhotoSchema.Type;

export const FxEmbedVideoSchema = Schema.Struct({
	height: Schema.Number,
	thumbnail_url: Schema.String,
	type: Schema.Literals(["video", "gif"]),
	url: Schema.String,
	width: Schema.Number,
});
export type FxEmbedVideo = typeof FxEmbedVideoSchema.Type;

export const FxEmbedMediaSchema = Schema.Struct({
	mosaic: Schema.optional(FxEmbedMosaicPhotoSchema),
	photos: Schema.optional(Schema.Array(FxEmbedPhotoSchema)),
	videos: Schema.optional(Schema.Array(FxEmbedVideoSchema)),
});
export type FxEmbedMedia = typeof FxEmbedMediaSchema.Type;

export const FxEmbedArticleCoverMediaSchema = Schema.Struct({
	media_id: Schema.String,
	media_info: Schema.Struct({
		__typename: Schema.Literal("ApiImage"),
		original_img_height: Schema.Number,
		original_img_width: Schema.Number,
		original_img_url: Schema.String,
	}),
	media_key: Schema.String,
});
export type FxEmbedArticleCoverMedia = typeof FxEmbedArticleCoverMediaSchema.Type;

export class FxEmbedArticle extends Schema.Class<FxEmbedArticle>("FxEmbedArticle")({
	cover_media: Schema.optional(FxEmbedArticleCoverMediaSchema),
	preview_text: Schema.String,
	title: Schema.String,
}) {
	toArticleData(): ArticleData {
		return {
			title: this.title,
			previewText: this.preview_text,
			coverMedia: this.cover_media
				? {
						url: this.cover_media.media_info.original_img_url,
						width: this.cover_media.media_info.original_img_width,
						height: this.cover_media.media_info.original_img_height,
					}
				: null,
		};
	}
}

export class FxEmbedTranslation extends Schema.Class<FxEmbedTranslation>("FxEmbedTranslation")({
	provider: Schema.optional(Schema.String),
	source_lang: Schema.String,
	source_lang_en: Schema.optional(Schema.String),
	target_lang: Schema.String,
	text: Schema.String,
}) {
	toTranslationData(): TweetData["translation"] {
		if (!this.text) {
			return null;
		}
		return {
			sourceLanguage: this.source_lang_en ?? this.source_lang.toUpperCase(),
		};
	}
}

function FxEmbedTweetSelf(): Schema.Schema<FxEmbedTweet> {
	return FxEmbedTweet as unknown as Schema.Schema<FxEmbedTweet>;
}

export class FxEmbedTweet extends Schema.Class<FxEmbedTweet>("FxEmbedTweet")({
	article: Schema.optional(Schema.NullOr(FxEmbedArticle)),
	author: FxEmbedAuthorSchema,
	created_at: Schema.String,
	created_timestamp: Schema.Number,
	id: Schema.String,
	likes: Schema.Number,
	media: Schema.optional(Schema.NullOr(FxEmbedMediaSchema)),
	quote: Schema.optional(Schema.NullOr(Schema.suspend(FxEmbedTweetSelf))),
	replies: Schema.Number,
	replying_to: Schema.optional(Schema.NullOr(Schema.String)),
	replying_to_status: Schema.optional(Schema.NullOr(Schema.String)),
	retweets: Schema.Number,
	text: Schema.String,
	translation: Schema.optional(Schema.NullOr(FxEmbedTranslation)),
	url: Schema.String,
	views: Schema.optional(Schema.Number),
}) {
	getDisplayText(): string {
		return this.translation?.text ?? this.text;
	}

	stripLeadingMention(username: string): string {
		const mentionPattern = new RegExp(`^@${username}\\s*`, "i");
		return this.getDisplayText().replace(mentionPattern, "").trim();
	}
}

export type FxEmbedTweetData = ConstructorParameters<typeof FxEmbedTweet>[0];

export const FxEmbedResponseSchema = Schema.Struct({
	code: Schema.Number,
	message: Schema.String,
	tweet: Schema.optional(Schema.NullOr(FxEmbedTweet)),
});
export type FxEmbedResponse = typeof FxEmbedResponseSchema.Type;

export const FxEmbedErrorCodeSchema = Schema.Literals([401, 404, 500]);
export type FxEmbedErrorCode = typeof FxEmbedErrorCodeSchema.Type;

export const FxEmbedErrorMessageSchema = Schema.Literals([
	"PRIVATE_TWEET",
	"NOT_FOUND",
	"API_FAIL",
]);
export type FxEmbedErrorMessage = typeof FxEmbedErrorMessageSchema.Type;

export const FxEmbedErrorSchema = Schema.Struct({
	code: FxEmbedErrorCodeSchema,
	message: FxEmbedErrorMessageSchema,
});
export type FxEmbedError = typeof FxEmbedErrorSchema.Type;

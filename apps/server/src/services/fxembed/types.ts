import { Schema } from "effect";
import type { ArticleData, LinkCardData, TweetData } from "@/services/render";

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

// Mirrors upstream APICardSchema: only `url` is guaranteed.
export class FxEmbedCard extends Schema.Class<FxEmbedCard>("FxEmbedCard")({
  domain: Schema.optional(Schema.String),
  image: Schema.optional(
    Schema.Struct({
      height: Schema.optional(Schema.Number),
      url: Schema.optional(Schema.String),
      width: Schema.optional(Schema.Number),
    }),
  ),
  title: Schema.optional(Schema.String),
  url: Schema.String,
}) {
  toLinkCardData(): LinkCardData | null {
    if (this.title === undefined || this.title === "") {
      return null;
    }

    const { image } = this;

    return {
      domain: this.domain ?? new URL(this.url).hostname,
      image:
        image?.url !== undefined && image.width !== undefined && image.height !== undefined
          ? { url: image.url, width: image.width, height: image.height }
          : null,
      title: this.title,
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

    // Prefer the ISO code over the English name: upstream derives source_lang_en
    // from an i18n key and leaks the raw key (e.g. "language_zh") when missing.
    return {
      sourceLanguage: this.source_lang,
    };
  }
}

function FxEmbedTweetSelf(): Schema.Codec<FxEmbedTweet, unknown> {
  return FxEmbedTweet;
}

export class FxEmbedTweet extends Schema.Class<FxEmbedTweet>("FxEmbedTweet")({
  article: Schema.optional(Schema.NullOr(FxEmbedArticle)),
  author: FxEmbedAuthorSchema,
  card: Schema.optional(Schema.NullOr(FxEmbedCard)),
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
  // Like X, the link preview only shows when no media or article takes its place.
  getLinkCard(): LinkCardData | null {
    const hasMedia = (this.media?.photos?.length ?? 0) > 0 || (this.media?.videos?.length ?? 0) > 0;

    return hasMedia || this.article ? null : (this.card?.toLinkCardData() ?? null);
  }

  // A shown link preview stands in for the trailing link, as on X.
  stripLinkCardUrl(text: string): string {
    const url = this.card?.url;

    if (url === undefined || this.getLinkCard() === null || !text.trimEnd().endsWith(url)) {
      return text;
    }

    return text.trimEnd().slice(0, -url.length).trimEnd();
  }

  getDisplayText(): string {
    return this.translation?.source_lang === "ru" ? this.text : (this.translation?.text ?? this.text);
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

export const FxEmbedErrorMessageSchema = Schema.Literals(["PRIVATE_TWEET", "NOT_FOUND", "API_FAIL"]);

export type FxEmbedErrorMessage = typeof FxEmbedErrorMessageSchema.Type;

export const FxEmbedErrorSchema = Schema.Struct({
  code: FxEmbedErrorCodeSchema,
  message: FxEmbedErrorMessageSchema,
});

export type FxEmbedError = typeof FxEmbedErrorSchema.Type;

import sharp from "sharp";
import { logger } from "@/logger";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import type { FxEmbedArticle, FxEmbedTweet } from "@/services/fxembed/types";
import {
	type ArticleData,
	type RenderResult,
	renderTweetImage,
	type TweetData,
} from "@/services/render";
import { s3 } from "@/storage";

export type Theme = "light" | "dark";

const TWEET_IMAGE_TRANSLATION_LANGUAGE = "en";

function mapArticleData(article: FxEmbedArticle | undefined): ArticleData | null {
	if (!article) {
		return null;
	}

	return {
		title: article.title,
		previewText: article.preview_text,
		coverMedia: article.cover_media
			? {
					url: article.cover_media.media_info.original_img_url,
					width: article.cover_media.media_info.original_img_width,
					height: article.cover_media.media_info.original_img_height,
				}
			: null,
	};
}

function getTweetText(tweet: Pick<FxEmbedTweet, "text" | "translation">): string {
	return tweet.translation?.text ?? tweet.text;
}

function mapTranslationData(tweet: Pick<FxEmbedTweet, "translation">): TweetData["translation"] {
	if (!tweet.translation?.text) {
		return null;
	}

	return {
		sourceLanguage: tweet.translation.source_lang_en ?? tweet.translation.source_lang.toUpperCase(),
	};
}

function mapMediaData(tweet: Pick<FxEmbedTweet, "media">): TweetData["media"] {
	if (!tweet.media) {
		return null;
	}

	return {
		mosaic: tweet.media.mosaic
			? {
					url: tweet.media.mosaic.url ?? tweet.media.mosaic.formats.jpeg,
					width: tweet.media.mosaic.width ?? 1200,
					height: tweet.media.mosaic.height ?? 900,
					formats: tweet.media.mosaic.formats,
				}
			: undefined,
		photos: tweet.media.photos,
		videos: tweet.media.videos?.map((v) => ({
			thumbnailUrl: v.thumbnail_url,
			width: v.width,
			height: v.height,
			type: v.type,
		})),
	};
}

function stripLeadingMention(text: string, username: string): string {
	const mentionPattern = new RegExp(`^@${username}\\s*`, "i");
	return text.replace(mentionPattern, "").trim();
}

const MAX_REPLY_CHAIN_DEPTH = 3;

interface ReplyChainResult {
	chain: TweetData[];
	hasMore: boolean;
}

async function fetchReplyChain(
	tweetId: string,
	depth = 0,
	childReplyingTo?: string,
): Promise<ReplyChainResult> {
	if (depth >= MAX_REPLY_CHAIN_DEPTH) {
		return { chain: [], hasMore: true };
	}

	const tweet = await fetchTweet(tweetId, TWEET_IMAGE_TRANSLATION_LANGUAGE);
	if (!tweet) {
		return { chain: [], hasMore: false };
	}

	const tweetText = childReplyingTo
		? stripLeadingMention(getTweetText(tweet), childReplyingTo)
		: getTweetText(tweet);

	const tweetData: TweetData = {
		authorName: tweet.author.name,
		authorUsername: tweet.author.screen_name,
		authorAvatarUrl: tweet.author.avatar_url,
		text: tweetText,
		createdAt: new Date(tweet.created_timestamp * 1000),
		media: mapMediaData(tweet),
		article: mapArticleData(tweet.article),
		likes: tweet.likes,
		retweets: tweet.retweets,
		replies: tweet.replies,
		translation: mapTranslationData(tweet),
		quote: tweet.quote
			? {
					authorName: tweet.quote.author.name,
					authorUsername: tweet.quote.author.screen_name,
					authorAvatarUrl: tweet.quote.author.avatar_url,
					text: getTweetText(tweet.quote),
					createdAt: new Date(tweet.quote.created_timestamp * 1000),
					media: mapMediaData(tweet.quote),
					article: mapArticleData(tweet.quote.article),
					likes: tweet.quote.likes,
					retweets: tweet.quote.retweets,
					replies: tweet.quote.replies,
					translation: mapTranslationData(tweet.quote),
				}
			: null,
	};

	if (tweet.replying_to_status) {
		const parentResult = await fetchReplyChain(
			tweet.replying_to_status,
			depth + 1,
			tweet.replying_to ?? undefined,
		);
		return {
			chain: [...parentResult.chain, tweetData],
			hasMore: parentResult.hasMore,
		};
	}

	return { chain: [tweetData], hasMore: false };
}

export type TweetImageResult = RenderResult;

export async function prepareTweetData(tweetId: string): Promise<TweetData> {
	const tweet = await fetchTweet(tweetId, TWEET_IMAGE_TRANSLATION_LANGUAGE);

	if (!tweet) {
		logger.warn({ tweetId }, "Could not fetch tweet");
		throw new Error("Tweet not found");
	}

	let replyChain: TweetData[] = [];
	let hasMoreInChain = false;

	if (tweet.replying_to_status) {
		const chainResult = await fetchReplyChain(tweet.replying_to_status);
		replyChain = chainResult.chain;
		hasMoreInChain = chainResult.hasMore;
	}

	const tweetText =
		tweet.replying_to && replyChain.length > 0
			? stripLeadingMention(getTweetText(tweet), tweet.replying_to)
			: getTweetText(tweet);

	return {
		authorName: tweet.author.name,
		authorUsername: tweet.author.screen_name,
		authorAvatarUrl: tweet.author.avatar_url,
		text: tweetText,
		createdAt: new Date(tweet.created_timestamp * 1000),
		media: mapMediaData(tweet),
		article: mapArticleData(tweet.article),
		likes: tweet.likes,
		retweets: tweet.retweets,
		replies: tweet.replies,
		translation: mapTranslationData(tweet),
		replyChain,
		hasMoreInChain,
		quote: tweet.quote
			? {
					authorName: tweet.quote.author.name,
					authorUsername: tweet.quote.author.screen_name,
					authorAvatarUrl: tweet.quote.author.avatar_url,
					text: getTweetText(tweet.quote),
					createdAt: new Date(tweet.quote.created_timestamp * 1000),
					media: mapMediaData(tweet.quote),
					article: mapArticleData(tweet.quote.article),
					likes: tweet.quote.likes,
					retweets: tweet.quote.retweets,
					replies: tweet.quote.replies,
					translation: mapTranslationData(tweet.quote),
				}
			: null,
	};
}

export async function generateTweetImage(
	tweetId: string,
	theme: Theme = "light",
): Promise<TweetImageResult> {
	const s3Path = `tweets/${tweetId}/${theme}.jpg`;
	const s3File = s3.file(s3Path);

	try {
		if (await s3File.exists()) {
			logger.debug({ tweetId, theme, s3Path }, "Found cached tweet image in S3");

			const cachedBuffer = Buffer.from(await s3File.arrayBuffer());
			const metadata = await sharp(cachedBuffer).metadata();

			return {
				buffer: cachedBuffer,
				width: metadata.width ?? 1100,
				height: metadata.height ?? 1200,
			};
		}
	} catch (error) {
		logger.warn(
			{ error, tweetId, theme, s3Path },
			"Failed to read cached image from S3, falling back to API",
		);
	}

	const tweetData = await prepareTweetData(tweetId);

	logger.debug({ tweetId, theme }, "Rendering tweet image");

	const result = await renderTweetImage(tweetData, theme);

	try {
		await s3.write(s3Path, result.buffer, { type: "image/jpeg" });
		logger.debug({ tweetId, theme, s3Path }, "Uploaded rendered tweet image to S3");
	} catch (error) {
		logger.warn({ error, tweetId, theme, s3Path }, "Failed to upload rendered image to S3");
	}

	return result;
}

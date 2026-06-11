import { http } from "@starlight/utils/http";
import { Effect } from "effect";
import type { TweetData } from "@/services/render";
import { renderTweetImage, type RenderResult } from "@/services/render";
import { type FxEmbedTweet, type FxEmbedMosaicPhoto } from "@/services/fxembed/types";
import { TwitterApi, TwitterApiError } from "@/services/twitter-api";
import { s3 } from "@/storage";

export type Theme = "light" | "dark";

const TWEET_IMAGE_TRANSLATION_LANGUAGE = "en";
const MOSAIC_METADATA_TIMEOUT_MS = 5000;

const getMosaicDimensions = Effect.fn("getMosaicDimensions")(
	(mosaic: FxEmbedMosaicPhoto): Effect.Effect<{ width: number; height: number }, never, never> =>
		Effect.gen(function* () {
			if (mosaic.width && mosaic.height) {
				return { width: mosaic.width, height: mosaic.height };
			}

			const dimensions = yield* Effect.tryPromise({
				try: async () => {
					const response = await http(mosaic.formats.jpeg, { timeout: MOSAIC_METADATA_TIMEOUT_MS });
					if (!response.ok) {
						throw new Error(`Failed to fetch mosaic: ${response.status}`);
					}
					const buffer = Buffer.from(await response.arrayBuffer());
					const metadata = await new Bun.Image(buffer).metadata();
					if (!metadata.width || !metadata.height) {
						throw new Error("Missing metadata");
					}
					return { width: metadata.width, height: metadata.height };
				},
				catch: (error) => error,
			}).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Failed to read mosaic dimensions", {
						error,
						url: mosaic.formats.jpeg,
					}),
				),
				Effect.orElseSucceed(() => ({ width: 1200, height: 900 })),
			);

			return dimensions;
		}),
);

const mapMediaData = Effect.fn("mapMediaData")(
	(media: FxEmbedTweet["media"]): Effect.Effect<TweetData["media"], never, never> =>
		Effect.gen(function* () {
			if (!media) {
				return null;
			}

			let mosaic: NonNullable<TweetData["media"]>["mosaic"];
			if (media.mosaic) {
				const dimensions = yield* getMosaicDimensions(media.mosaic);
				mosaic = {
					url: media.mosaic.url ?? media.mosaic.formats.jpeg,
					width: dimensions.width,
					height: dimensions.height,
					formats: media.mosaic.formats,
				};
			}

			return {
				mosaic,
				photos: media.photos?.map((p) => ({ url: p.url, width: p.width, height: p.height })),
				videos: media.videos?.map((v) => ({
					thumbnailUrl: v.thumbnail_url,
					width: v.width,
					height: v.height,
					type: v.type,
				})),
			};
		}),
);

function buildTweetData(
	tweet: FxEmbedTweet,
	textOverride?: string,
): Effect.Effect<TweetData, never, never> {
	return Effect.gen(function* () {
		const media = yield* mapMediaData(tweet.media);

		const quote = tweet.quote
			? yield* buildTweetData(tweet.quote, tweet.quote.getDisplayText())
			: null;

		return {
			authorName: tweet.author.name,
			authorUsername: tweet.author.screen_name,
			authorAvatarUrl: tweet.author.avatar_url,
			text: textOverride ?? tweet.getDisplayText(),
			createdAt: new Date(tweet.created_timestamp * 1000),
			media,
			article: tweet.article?.toArticleData() ?? null,
			likes: tweet.likes,
			retweets: tweet.retweets,
			replies: tweet.replies,
			translation: tweet.translation?.toTranslationData() ?? null,
			quote,
		} satisfies TweetData;
	});
}

const MAX_REPLY_CHAIN_DEPTH = 3;

interface ReplyChainResult {
	chain: TweetData[];
	hasMore: boolean;
}

function fetchReplyChain(
	tweetId: string,
	depth = 0,
	childReplyingTo?: string,
): Effect.Effect<ReplyChainResult, TwitterApiError, TwitterApi.Service> {
	return Effect.gen(function* () {
		if (depth >= MAX_REPLY_CHAIN_DEPTH) {
			return { chain: [], hasMore: true };
		}

		const twitterApi = yield* TwitterApi.Service;
		const tweet = yield* twitterApi.getFxTweet(tweetId, TWEET_IMAGE_TRANSLATION_LANGUAGE);

		if (!tweet) {
			return { chain: [], hasMore: false };
		}

		const tweetText = childReplyingTo
			? tweet.stripLeadingMention(childReplyingTo)
			: tweet.getDisplayText();

		const tweetData = yield* buildTweetData(tweet, tweetText);

		if (tweet.replying_to_status) {
			const parentResult = yield* fetchReplyChain(
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
	});
}

export const prepareTweetData = Effect.fn("prepareTweetData")(
	(tweetId: string): Effect.Effect<TweetData, TwitterApiError | Error, TwitterApi.Service> =>
		Effect.gen(function* () {
			const twitterApi = yield* TwitterApi.Service;
			const tweet = yield* twitterApi.getFxTweet(tweetId, TWEET_IMAGE_TRANSLATION_LANGUAGE);

			if (!tweet) {
				yield* Effect.logWarning("Could not fetch tweet", { tweetId });
				return yield* Effect.fail(new Error("Tweet not found"));
			}

			let replyChain: TweetData[] = [];
			let hasMoreInChain = false;

			if (tweet.replying_to_status) {
				const chainResult = yield* fetchReplyChain(tweet.replying_to_status);
				replyChain = chainResult.chain;
				hasMoreInChain = chainResult.hasMore;
			}

			const tweetText =
				tweet.replying_to && replyChain.length > 0
					? tweet.stripLeadingMention(tweet.replying_to)
					: tweet.getDisplayText();

			const base = yield* buildTweetData(tweet, tweetText);

			return {
				...base,
				replyChain,
				hasMoreInChain,
			};
		}),
);

export type TweetImageResult = RenderResult;

export const generateTweetImage = Effect.fn("generateTweetImage")(
	(
		tweetId: string,
		theme: Theme = "light",
	): Effect.Effect<RenderResult, TwitterApiError | Error, TwitterApi.Service> =>
		Effect.gen(function* () {
			const s3Path = `tweets/${tweetId}/${theme}.jpg`;
			const s3File = s3.file(s3Path);

			const cachedResult = yield* Effect.tryPromise({
				try: async () => {
					if (await s3File.exists()) {
						const buffer = Buffer.from(await s3File.arrayBuffer());
						const metadata = await new Bun.Image(buffer).metadata();
						return {
							buffer,
							width: metadata.width ?? 1100,
							height: metadata.height ?? 1200,
						} satisfies RenderResult;
					}
					return null;
				},
				catch: (error) => error,
			}).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Failed to read cached image from S3, falling back to API", {
						error,
						tweetId,
						theme,
						s3Path,
					}),
				),
				Effect.orElseSucceed(() => null),
			);

			if (cachedResult) {
				yield* Effect.logDebug("Found cached tweet image in S3", { tweetId, theme, s3Path });
				return cachedResult;
			}

			const tweetData = yield* prepareTweetData(tweetId);

			yield* Effect.logDebug("Rendering tweet image", { tweetId, theme });

			const result = yield* Effect.tryPromise({
				try: () => renderTweetImage(tweetData, theme),
				catch: (error) => new Error(`Failed to render tweet image: ${error}`),
			});

			const uploaded = yield* Effect.tryPromise({
				try: async () => {
					await s3.write(s3Path, result.buffer, { type: "image/jpeg" });
					return true;
				},
				catch: (error) => error,
			}).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Failed to upload rendered image to S3", {
						error,
						tweetId,
						theme,
						s3Path,
					}),
				),
				Effect.orElseSucceed(() => false),
			);

			if (uploaded) {
				yield* Effect.logDebug("Uploaded rendered tweet image to S3", { tweetId, theme, s3Path });
			}

			return result;
		}),
);

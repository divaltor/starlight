import { env, extractTweetId, isTwitterUrl } from "@starlight/utils";
import { Composer, InlineQueryResultBuilder } from "grammy";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import { renderTweetImage, type TweetData } from "@/services/render";
import { redis, s3 } from "@/storage";
import type { Context } from "@/types";

function stripLeadingMention(text: string, username: string): string {
	const mentionPattern = new RegExp(`^@${username}\\s*`, "i");
	return text.replace(mentionPattern, "").trim();
}

const MAX_REPLY_CHAIN_DEPTH = 3;

type ReplyChainResult = {
	chain: TweetData[];
	hasMore: boolean;
};

async function fetchReplyChain(
	tweetId: string,
	depth = 0
): Promise<ReplyChainResult> {
	if (depth >= MAX_REPLY_CHAIN_DEPTH) {
		return { chain: [], hasMore: true };
	}

	const tweet = await fetchTweet(tweetId);
	if (!tweet) {
		return { chain: [], hasMore: false };
	}

	const tweetData: TweetData = {
		authorName: tweet.author.name,
		authorUsername: tweet.author.screen_name,
		authorAvatarUrl: tweet.author.avatar_url,
		text: tweet.text,
		createdAt: new Date(tweet.created_timestamp * 1000),
		media: tweet.media
			? {
					photos: tweet.media.photos,
				}
			: null,
		likes: tweet.likes,
		retweets: tweet.retweets,
		replies: tweet.replies,
	};

	if (tweet.replying_to_status) {
		const parentResult = await fetchReplyChain(
			tweet.replying_to_status,
			depth + 1
		);
		return {
			chain: [...parentResult.chain, tweetData],
			hasMore: parentResult.hasMore,
		};
	}

	return { chain: [tweetData], hasMore: false };
}

const tweetImageRateLimiter = new RateLimiterRedis({
	storeClient: redis,
	points: 15,
	duration: 60,
	keyPrefix: "tweet-image",
});

const composer = new Composer<Context>();

composer.on("inline_query").filter(
	(ctx) => isTwitterUrl(ctx.inlineQuery.query.trim()),
	async (ctx) => {
		const query = ctx.inlineQuery.query.trim();
		const tweetId = extractTweetId(query);

		ctx.logger.info(
			{ userId: ctx.from.id, query, tweetId },
			"Processing inline query for tweet"
		);

		if (!tweetId) {
			ctx.logger.debug(
				{ query },
				"Failed to extract tweet ID from inline query"
			);
			await ctx.answerInlineQuery([]);
			return;
		}

		try {
			const tweet = await fetchTweet(tweetId);

			if (!tweet) {
				ctx.logger.warn({ tweetId }, "Tweet not found for inline query");
				await ctx.answerInlineQuery([
					InlineQueryResultBuilder.article(
						`tweet-not-found:${tweetId}`,
						"Tweet not found"
					).text("Could not fetch this tweet. It may be private or deleted."),
				]);
				return;
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
					? stripLeadingMention(tweet.text, tweet.replying_to)
					: tweet.text;

			const tweetData: TweetData = {
				authorName: tweet.author.name,
				authorUsername: tweet.author.screen_name,
				authorAvatarUrl: tweet.author.avatar_url,
				text: tweetText,
				createdAt: new Date(tweet.created_timestamp * 1000),
				media: tweet.media
					? {
							photos: tweet.media.photos,
						}
					: null,
				likes: tweet.likes,
				retweets: tweet.retweets,
				replies: tweet.replies,
				replyChain,
				hasMoreInChain,
				quote: tweet.quote
					? {
							authorName: tweet.quote.author.name,
							authorUsername: tweet.quote.author.screen_name,
							authorAvatarUrl: tweet.quote.author.avatar_url,
							text: tweet.quote.text,
							createdAt: new Date(tweet.quote.created_timestamp * 1000),
							media: tweet.quote.media
								? {
										photos: tweet.quote.media.photos,
									}
								: null,
							likes: tweet.quote.likes,
							retweets: tweet.quote.retweets,
							replies: tweet.quote.replies,
						}
					: null,
			};

			const [lightResult, darkResult] = await Promise.all([
				renderTweetImage(tweetData, "light"),
				renderTweetImage(tweetData, "dark"),
			]);

			const lightS3Path = `tweets/${tweetId}/light.jpg`;
			const darkS3Path = `tweets/${tweetId}/dark.jpg`;

			await Promise.all([
				s3.write(lightS3Path, lightResult.buffer, { type: "image/jpeg" }),
				s3.write(darkS3Path, darkResult.buffer, { type: "image/jpeg" }),
			]);

			ctx.logger.debug(
				{ tweetId, lightS3Path, darkS3Path },
				"Uploaded tweet images to S3"
			);

			const lightUrl = `${env.BASE_CDN_URL}/${lightS3Path}`;
			const darkUrl = `${env.BASE_CDN_URL}/${darkS3Path}`;

			const results = [
				InlineQueryResultBuilder.photo(`tweet:${tweetId}:light`, lightUrl, {
					thumbnail_url: lightUrl,
					caption: `https://x.com/i/status/${tweetId}`,
					photo_width: lightResult.width,
					photo_height: lightResult.height,
				}),
				InlineQueryResultBuilder.photo(`tweet:${tweetId}:dark`, darkUrl, {
					thumbnail_url: darkUrl,
					caption: `https://x.com/i/status/${tweetId}`,
					photo_width: darkResult.width,
					photo_height: darkResult.height,
				}),
			];

			await tweetImageRateLimiter.consume(ctx.from.id);

			await ctx.answerInlineQuery(results, {
				cache_time: 300,
			});

			ctx.logger.info({ tweetId }, "Inline query answered successfully");
		} catch (error) {
			ctx.logger.error(
				{ error, tweetId },
				"Failed to generate inline tweet images"
			);
			await ctx.answerInlineQuery([]);
		}
	}
);

export default composer;

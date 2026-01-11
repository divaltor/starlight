import { env, extractTweetId, isTwitterUrl } from "@starlight/utils";
import {
	Composer,
	GrammyError,
	InlineKeyboard,
	InlineQueryResultBuilder,
	InputFile,
} from "grammy";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import { renderTweetImage, type TweetData } from "@/services/render";
import {
	generateTweetImage,
	type Theme,
} from "@/services/tweet/tweet-image.service";
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
const privateChat = composer.chatType("private");

function createThemeKeyboard(
	tweetId: string,
	currentTheme: Theme
): InlineKeyboard {
	const nextTheme = currentTheme === "dark" ? "light" : "dark";
	const buttonText = currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";

	return new InlineKeyboard().text(
		buttonText,
		`tweet_img:toggle:${tweetId}:${nextTheme}`
	);
}

async function hasRateLimitPoints(userId: number): Promise<boolean> {
	const rateLimitRes = await tweetImageRateLimiter.get(String(userId));
	const consumed = rateLimitRes?.consumedPoints ?? 0;
	return consumed < 15;
}

privateChat.command(["img", "i"]).filter(
	(ctx) => ctx.match.trim() === "",
	async (ctx) => {
		ctx.logger.debug({ userId: ctx.from.id }, "Empty /img command received");
		await ctx.reply("Usage: /img <twitter_url>");
	}
);

privateChat.command(["img", "i"]).filter(
	(ctx) => ctx.match.trim() !== "" && extractTweetId(ctx.match.trim()) === null,
	async (ctx) => {
		ctx.logger.debug(
			{ userId: ctx.from.id, input: ctx.match.trim() },
			"Invalid tweet URL provided"
		);
		await ctx.reply("Please provide a valid tweet link");
	}
);

privateChat
	.command(["img", "i"])
	.filter((ctx) => extractTweetId(ctx.match.trim()) !== null)
	.filter(
		async (ctx) => !hasRateLimitPoints(ctx.from.id),
		async (ctx) => {
			ctx.logger.info({ userId: ctx.from.id }, "Rate limit exceeded for /img");
			await ctx.reply(
				"You've reached the limit of 15 image requests per minute.\n" +
					"Please wait a moment before trying again."
			);
		}
	);

privateChat
	.command(["img", "i"])
	.filter((ctx) => extractTweetId(ctx.match.trim()) !== null)
	.filter(
		async (ctx) => hasRateLimitPoints(ctx.from.id),
		async (ctx) => {
			const tweetId = extractTweetId(ctx.match.trim()) as string;

			ctx.logger.info(
				{ userId: ctx.from.id, tweetId },
				"Processing /img command"
			);

			await ctx.replyWithChatAction("upload_photo");

			try {
				const result = await generateTweetImage(tweetId, "light");

				ctx.logger.debug({ tweetId }, "Tweet image generated successfully");

				await ctx.replyWithPhoto(
					new InputFile(result.buffer, `tweet-${tweetId}.jpg`),
					{
						reply_markup: createThemeKeyboard(tweetId, "light"),
					}
				);

				await tweetImageRateLimiter.consume(ctx.from.id);
			} catch (error) {
				ctx.logger.error({ error, tweetId }, "Failed to generate tweet image");

				if (error instanceof Error && error.message === "Tweet not found") {
					await ctx.reply(
						"Could not fetch this tweet. It may be:\n" +
							"• Private or from a protected account\n" +
							"• Deleted\n" +
							"• Invalid URL"
					);
					return;
				}

				if (error instanceof GrammyError) {
					await ctx.reply("Failed to send image. Please try again.");
				} else {
					await ctx.reply("Something went wrong. Please try again later.");
				}
			}
		}
	);

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
			ctx.logger.debug({ query }, "Failed to extract tweet ID from inline query");
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
			};

			const [lightResult, darkResult] = await Promise.all([
				renderTweetImage(tweetData, "light"),
				renderTweetImage(tweetData, "dark"),
			]);

			const lightS3Path = `tweets/${tweetId}/light.jpg`;
			const darkS3Path = `tweets/${tweetId}/dark.jpg`;

			await Promise.all([
				s3.write(lightS3Path, lightResult.buffer),
				s3.write(darkS3Path, darkResult.buffer),
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
				}),
				InlineQueryResultBuilder.photo(`tweet:${tweetId}:dark`, darkUrl, {
					thumbnail_url: darkUrl,
					caption: `https://x.com/i/status/${tweetId}`,
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

privateChat.callbackQuery(
	/^tweet_img:toggle:(\d+):(light|dark)$/,
	async (ctx) => {
		const match = ctx.match;

		if (!match) {
			ctx.logger.debug("Callback query without match");
			await ctx.answerCallbackQuery();
			return;
		}

		const tweetId = match.at(1);
		const newTheme = match.at(2) as Theme;

		if (!tweetId) {
			ctx.logger.debug("Callback query missing tweetId");
			await ctx.answerCallbackQuery();
			return;
		}

		ctx.logger.info(
			{ userId: ctx.from.id, tweetId, newTheme },
			"Processing theme toggle callback"
		);

		await ctx.answerCallbackQuery({
			text: `Generating ${newTheme} theme...`,
		});

		try {
			const result = await generateTweetImage(tweetId, newTheme);

			ctx.logger.debug({ tweetId, newTheme }, "Theme toggle image generated");

			await tweetImageRateLimiter.consume(ctx.from.id);

			await ctx.editMessageMedia(
				{
					type: "photo",
					media: new InputFile(result.buffer, `tweet-${tweetId}.jpg`),
				},
				{
					reply_markup: createThemeKeyboard(tweetId, newTheme),
				}
			);
		} catch (error) {
			if (error instanceof GrammyError) {
				ctx.logger.warn(
					{ error, tweetId },
					"Failed to edit message for theme toggle"
				);
			} else {
				throw error;
			}
		}
	}
);

export default composer;

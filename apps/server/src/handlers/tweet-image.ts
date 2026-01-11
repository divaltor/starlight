import { env, extractTweetId, isTwitterUrl } from "@starlight/utils";
import {
	Composer,
	GrammyError,
	InlineKeyboard,
	InlineQueryResultBuilder,
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
	const buttonText = currentTheme === "dark" ? "☀ Light" : "🌙 Dark";

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
		await ctx.reply("Usage: /img <twitter_url>");
	}
);

privateChat.command(["img", "i"]).filter(
	(ctx) => ctx.match.trim() !== "" && extractTweetId(ctx.match.trim()) === null,
	async (ctx) => {
		await ctx.reply("Please provide a valid tweet link");
	}
);

privateChat
	.command(["img", "i"])
	.filter((ctx) => extractTweetId(ctx.match.trim()) !== null)
	.filter(
		async (ctx) => !hasRateLimitPoints(ctx.from.id),
		async (ctx) => {
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

			await ctx.replyWithChatAction("upload_photo");

			try {
				const result = await generateTweetImage(
					tweetId,
					ctx.api,
					ctx.chat.id,
					"light"
				);

				await tweetImageRateLimiter.consume(ctx.from.id);

				await ctx.api.editMessageMedia(
					ctx.chat.id,
					result.messageId,
					{
						type: "photo",
						media: result.fileId,
					},
					{
						reply_markup: createThemeKeyboard(tweetId, "light"),
					}
				);
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

		if (!tweetId) {
			await ctx.answerInlineQuery([]);
			return;
		}

		try {
			const tweet = await fetchTweet(tweetId);

			if (!tweet) {
				await ctx.answerInlineQuery([
					InlineQueryResultBuilder.article(
						`tweet-not-found:${tweetId}`,
						"Tweet not found"
					).text("Could not fetch this tweet. It may be private or deleted."),
				]);
				return;
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

			const [lightResult, darkResult] = await Promise.all([
				renderTweetImage(tweetData, "light"),
				renderTweetImage(tweetData, "dark"),
			]);

			const lightS3Path = `tweets/${tweetId}/light.png`;
			const darkS3Path = `tweets/${tweetId}/dark.png`;

			await Promise.all([
				s3.write(lightS3Path, lightResult.buffer),
				s3.write(darkS3Path, darkResult.buffer),
			]);

			const lightUrl = `${env.BASE_CDN_URL}/${lightS3Path}`;
			const darkUrl = `${env.BASE_CDN_URL}/${darkS3Path}`;

			const results = [
				InlineQueryResultBuilder.photo(`tweet:${tweetId}:light`, lightUrl, {
					thumbnail_url: lightUrl,
					caption: `https://x.com/i/status/${tweetId}`,
					photo_width: Math.round(lightResult.width),
					photo_height: Math.round(lightResult.height),
				}),
				InlineQueryResultBuilder.photo(`tweet:${tweetId}:dark`, darkUrl, {
					thumbnail_url: darkUrl,
					caption: `https://x.com/i/status/${tweetId}`,
					photo_width: Math.round(darkResult.width),
					photo_height: Math.round(darkResult.height),
				}),
			];

			await tweetImageRateLimiter.consume(ctx.from.id);

			await ctx.answerInlineQuery(results, {
				cache_time: 300,
			});
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
			await ctx.answerCallbackQuery();
			return;
		}

		const tweetId = match.at(1);
		const newTheme = match.at(2) as Theme;

		if (!tweetId) {
			await ctx.answerCallbackQuery();
			return;
		}

		await ctx.answerCallbackQuery({
			text: `Generating ${newTheme} theme...`,
		});

		try {
			const result = await generateTweetImage(
				tweetId,
				ctx.api,
				ctx.chat.id,
				newTheme
			);

			await tweetImageRateLimiter.consume(ctx.from.id);

			await ctx.editMessageMedia(
				{
					type: "photo",
					media: result.fileId,
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

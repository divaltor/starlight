import { extractTweetId } from "@starlight/utils";
import { Composer, GrammyError, InlineKeyboard } from "grammy";
import { RateLimiterRedis } from "rate-limiter-flexible";
import {
	generateTweetImage,
	type Theme,
} from "@/services/tweet/tweet-image.service";
import { redis } from "@/storage";
import type { Context } from "@/types";

const tweetImageRateLimiter = new RateLimiterRedis({
	storeClient: redis,
	points: 10,
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
	return consumed < 10;
}

privateChat.command(["img", "i"]).filter(
	(ctx) => ctx.match.trim() === "",
	async (ctx) => {
		await ctx.reply(
			"Usage: /img <twitter_url>\n\n" +
				"Example: /img https://x.com/user/status/1234567890"
		);
	}
);

privateChat.command(["img", "i"]).filter(
	(ctx) => ctx.match.trim() !== "" && extractTweetId(ctx.match.trim()) === null,
	async (ctx) => {
		await ctx.reply(
			"Invalid Twitter/X URL. Please provide a valid tweet link.\n\n" +
				"Supported formats:\n" +
				"• https://twitter.com/user/status/123\n" +
				"• https://x.com/user/status/123"
		);
	}
);

privateChat
	.command(["img", "i"])
	.filter((ctx) => extractTweetId(ctx.match.trim()) !== null)
	.filter(
		async (ctx) => !hasRateLimitPoints(ctx.from.id),
		async (ctx) => {
			await ctx.reply(
				"You've reached the limit of 10 image requests per minute.\n" +
					"Please wait a moment before trying again."
			);
		}
	)
	.use(async (ctx) => {
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

			await ctx.api.deleteMessage(ctx.chat.id, result.messageId);

			await ctx.replyWithPhoto(result.fileId, {
				reply_markup: createThemeKeyboard(tweetId, "light"),
			});
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
	});

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

			try {
				await ctx.api.deleteMessage(ctx.chat.id, result.messageId);
			} catch {
				ctx.logger.debug({ tweetId }, "Failed to delete temp message");
			}

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

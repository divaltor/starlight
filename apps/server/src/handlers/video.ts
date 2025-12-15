import { prisma } from "@starlight/utils";
import { Scraper, type Tweet } from "@the-convocation/twitter-scraper";
import { Composer, GrammyError, InlineKeyboard, InputFile } from "grammy";
import tmp from "tmp";
import { downloadVideo, type VideoInformation } from "@/services/video";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const feature = composer.chatType("private");

function extractTweetId(url: string): string {
	const match = url.match(
		/https?:\/\/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/
	);
	return match?.[1] ?? "";
}

function cleanupTweetText(text: string | undefined): string | undefined {
	if (!text) {
		return;
	}

	return (
		text
			// Remove all hashtags
			.replace(/#[\p{L}0-9_]+/gu, "")
			// Remove all URLs
			.replace(/https?:\/\/\S+/g, "")
			.trim()
	);
}

function createVideoKeyboard(
	videoId: string,
	hasDescription: boolean
): InlineKeyboard {
	const keyboard = new InlineKeyboard();
	if (hasDescription) {
		keyboard.text("Remove description", `video:remove_desc:${videoId}`);
	} else {
		keyboard.text("Add description", `video:add_desc:${videoId}`);
	}
	return keyboard;
}

feature.on(":text").filter(
	(ctx) => ctx.msg.text.startsWith("https://x.com"),
	async (ctx) => {
		if (!ctx.user) {
			await ctx.reply("You need to be registered to use this feature.");
			return;
		}

		await ctx.replyWithChatAction("upload_video");

		const link = ctx.msg.text;
		const tweetId = extractTweetId(link);
		const tempDir = tmp.dirSync({ unsafeCleanup: true });

		let videos: VideoInformation[] = [];
		let tweet: Tweet | null = null;

		const scrapper = new Scraper({
			experimental: { xClientTransactionId: true, xpff: true },
		});

		try {
			[videos, tweet] = await Promise.all([
				downloadVideo(link, tempDir.name),
				scrapper.getTweet(tweetId).catch((error) => {
					ctx.logger.error({ error }, "Error getting tweet");
					return null;
				}),
			]);
		} catch (error) {
			ctx.logger.error(error, "Error downloading video");

			await ctx.reply("Can't download video, sorry.");
			return;
		}

		const cleanedText = cleanupTweetText(tweet?.text);

		for (const video of videos) {
			try {
				ctx.logger.debug("Sending video %s to %s", video.filePath, ctx.chatId);

				const sentMessage = await ctx.replyWithVideo(
					new InputFile(video.filePath),
					{
						width: video.metadata?.width,
						height: video.metadata?.height,
						caption: cleanedText,
					}
				);

				const savedVideo = await prisma.video.create({
					data: {
						userId: ctx.user.id,
						tweetId,
						tweetText: tweet?.text,
						telegramFileId: sentMessage.video.file_id,
						telegramFileUniqueId: sentMessage.video.file_unique_id,
						width: sentMessage.video.width,
						height: sentMessage.video.height,
					},
				});

				if (cleanedText) {
					await ctx.api.editMessageReplyMarkup(
						ctx.chatId,
						sentMessage.message_id,
						{ reply_markup: createVideoKeyboard(savedVideo.id, false) }
					);
				}

				ctx.logger.info(
					"Video %s sent successfully to %s",
					video.filePath,
					ctx.chatId
				);
			} catch (error) {
				if (error instanceof GrammyError) {
					ctx.logger.error(error, "Error sending video");
					if (error.error_code === 413) {
						await ctx.reply("Video is too large, can't be sent.");
					} else {
						await ctx.reply("Can't download video, sorry.");
						throw error;
					}
				}
			}
		}

		tempDir.removeCallback();
	}
);

// Callback query handler for adding description
feature.callbackQuery(/^video:add_desc:(.+)$/, async (ctx) => {
	const videoId = ctx.match[1];

	if (!videoId) {
		await ctx.answerCallbackQuery({ text: "Invalid video ID" });
		return;
	}

	const video = await prisma.video.findUnique({
		where: { id: videoId },
	});

	if (!video) {
		await ctx.answerCallbackQuery({ text: "Video not found" });
		return;
	}

	if (!video.tweetText) {
		await ctx.answerCallbackQuery({ text: "No tweet text available" });
		return;
	}

	const cleanedText = cleanupTweetText(video.tweetText);

	await ctx.editMessageCaption({
		caption: cleanedText ?? "",
		reply_markup: createVideoKeyboard(videoId, true),
	});

	await ctx.answerCallbackQuery({ text: "Description added" });
});

// Callback query handler for removing description
feature.callbackQuery(/^video:remove_desc:(.+)$/, async (ctx) => {
	const videoId = ctx.match[1];

	if (!videoId) {
		await ctx.answerCallbackQuery({ text: "Invalid video ID" });
		return;
	}

	const video = await prisma.video.findUnique({
		where: { id: videoId },
	});

	if (!video) {
		await ctx.answerCallbackQuery({ text: "Video not found" });
		return;
	}

	await ctx.editMessageCaption({
		caption: undefined,
		reply_markup: createVideoKeyboard(videoId, false),
	});

	await ctx.answerCallbackQuery({ text: "Description removed" });
});

export default composer;

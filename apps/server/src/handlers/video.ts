/** biome-ignore-all lint/correctness/noUndeclaredVariables: <explanation> */
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

		// Check if video already exists in database
		const existingVideo = await prisma.video.findFirst({
			where: { tweetId },
			orderBy: { createdAt: "desc" },
		});

		if (existingVideo) {
			ctx.logger.info(
				"Found existing video for tweet %s, sending via file_id",
				tweetId
			);

			try {
				await ctx.replyWithVideo(existingVideo.telegramFileId, {
					width: existingVideo.width ?? undefined,
					height: existingVideo.height ?? undefined,
					supports_streaming: true,
					reply_markup: existingVideo.tweetText
						? createVideoKeyboard(existingVideo.id, false)
						: undefined,
				});

				ctx.logger.info("Existing video sent successfully to %s", ctx.chatId);
				return;
			} catch (error) {
				ctx.logger.error(
					{ error, videoId: existingVideo.id },
					"Error sending existing video, will download fresh copy"
				);
				// Continue to download fresh copy if sending existing file fails
			}
		}

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

				const videoId = Bun.randomUUIDv7();

				const sentMessage = await ctx.replyWithVideo(
					new InputFile(video.filePath),
					{
						width: video.metadata?.width,
						height: video.metadata?.height,
						supports_streaming: true,
						reply_markup: cleanedText
							? createVideoKeyboard(videoId, false)
							: undefined,
					}
				);

				await prisma.video.create({
					data: {
						id: videoId,
						userId: ctx.user.id,
						tweetId,
						tweetText: cleanedText,
						telegramFileId: sentMessage.video.file_id,
						telegramFileUniqueId: sentMessage.video.file_unique_id,
						width: sentMessage.video.width,
						height: sentMessage.video.height,
					},
				});

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
	await ctx.answerCallbackQuery();

	const videoId = ctx.match[1];

	if (!videoId) {
		return;
	}

	const video = await prisma.video.findUnique({
		where: { id: videoId },
	});

	if (!video) {
		return;
	}

	try {
		await ctx.editMessageCaption({
			caption: video.tweetText ?? undefined,
			reply_markup: createVideoKeyboard(videoId, true),
		});
	} catch (error) {
		if (error instanceof GrammyError) {
			ctx.logger.warn(
				{ error, videoId },
				"Failed to edit message, resending video"
			);

			await ctx.replyWithVideo(video.telegramFileId, {
				width: video.width ?? undefined,
				height: video.height ?? undefined,
				supports_streaming: true,
				caption: video.tweetText ?? undefined,
				reply_markup: createVideoKeyboard(videoId, true),
			});
		} else {
			throw error;
		}
	}
});

// Callback query handler for removing description
feature.callbackQuery(/^video:remove_desc:(.+)$/, async (ctx) => {
	await ctx.answerCallbackQuery();

	const videoId = ctx.match[1];

	if (!videoId) {
		return;
	}

	const video = await prisma.video.findUnique({
		where: { id: videoId },
	});

	if (!video) {
		return;
	}

	try {
		await ctx.editMessageCaption({
			caption: undefined,
			reply_markup: createVideoKeyboard(videoId, false),
		});
	} catch (error) {
		if (error instanceof GrammyError) {
			ctx.logger.warn(
				{ error, videoId },
				"Failed to edit message, resending video"
			);

			await ctx.replyWithVideo(video.telegramFileId, {
				width: video.width ?? undefined,
				height: video.height ?? undefined,
				supports_streaming: true,
				reply_markup: createVideoKeyboard(videoId, false),
			});
		} else {
			throw error;
		}
	}
});

export default composer;

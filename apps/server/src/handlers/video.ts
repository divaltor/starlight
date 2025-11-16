import { Scraper, type Tweet } from "@the-convocation/twitter-scraper";
import { Composer, GrammyError, InputFile } from "grammy";
import tmp from "tmp";
import { downloadVideo, type VideoInformation } from "@/services/video";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const feature = composer.chatType("private");

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

feature.command("q").filter(
	(ctx) => ctx.match.startsWith("https://x.com"),
	async (ctx) => {
		await ctx.replyWithChatAction("upload_video");

		const link = ctx.match;
		const tempDir = tmp.dirSync({ unsafeCleanup: true });

		let videos: VideoInformation[] = [];
		let tweet: Tweet | null = null;

		const scrapper = new Scraper({
			experimental: { xClientTransactionId: true, xpff: true },
		});

		try {
			[videos, tweet] = await Promise.all([
				downloadVideo(link, tempDir.name),
				scrapper.getTweet(link).catch((error) => {
					ctx.logger.error({ error }, "Error getting tweet");
					return null;
				}),
			]);
		} catch (error) {
			ctx.logger.error(error, "Error downloading video");

			await ctx.reply("Can't download video, sorry.");
			return;
		}

		for (const video of videos) {
			try {
				ctx.logger.debug("Sending video %s to %s", video.filePath, ctx.chatId);
				await ctx.replyWithVideo(new InputFile(video.filePath), {
					width: video.metadata?.width,
					height: video.metadata?.height,
					caption: cleanupTweetText(tweet?.text),
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

feature.on(":text").filter(
	(ctx) => ctx.msg.text.startsWith("https://x.com"),
	async (ctx) => {
		await ctx.replyWithChatAction("upload_video");

		const tempDir = tmp.dirSync({ unsafeCleanup: true });

		let videos: VideoInformation[] = [];

		try {
			videos = await downloadVideo(ctx.msg.text, tempDir.name);
		} catch (error) {
			ctx.logger.error(error, "Error downloading video");

			await ctx.reply("Can't download video, sorry.");
			return;
		}

		for (const video of videos) {
			try {
				ctx.logger.debug("Sending video %s to %s", video.filePath, ctx.chatId);
				await ctx.replyWithVideo(new InputFile(video.filePath), {
					width: video.metadata?.width,
					height: video.metadata?.height,
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

export default composer;

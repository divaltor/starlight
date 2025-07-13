import { env } from "@repo/utils";
import { Composer, GrammyError, InputFile } from "grammy";
import tmp from "tmp";
import { downloadVideo } from "@/services/video";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const feature = composer.chatType("private");

feature.on(":text").filter(
	(ctx) =>
		ctx.msg.text.startsWith("https://x.com") ||
		ctx.msg.text.startsWith("https://www.instagram.com") ||
		ctx.msg.text.startsWith("https://instagram.com"),
	async (ctx) => {
		await ctx.replyWithChatAction("upload_video");

		const tempDir = tmp.dirSync({ unsafeCleanup: true });

		let videos = [];
		let cookies: string | undefined;

		if (ctx.msg.text.includes("instagram.com")) {
			cookies = env.INSTAGRAM_COOKIES;
		}

		try {
			videos = await downloadVideo(ctx.msg.text, tempDir.name, cookies);
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
					ctx.chatId,
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
	},
);

export default composer;

/** biome-ignore-all lint/correctness/noUndeclaredVariables: Global Bun */
import { env } from "@starlight/utils";
import { Composer, GrammyError, InputFile } from "grammy";
import tmp from "tmp";
import { downloadViaCobalt } from "@/services/cobalt";
import type { Context } from "@/types";

const TIKTOK_REGEX =
	/^https?:\/\/(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\//;
const INSTAGRAM_REGEX =
	/^https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\//;

const composer = new Composer<Context>();

const feature = composer.chatType("private").filter(() => !!env.COBALT_API_URL);

feature.on(":text").filter(
	(ctx) =>
		TIKTOK_REGEX.test(ctx.msg.text) || INSTAGRAM_REGEX.test(ctx.msg.text),

	async (ctx) => {
		if (!ctx.user) {
			await ctx.reply("You need to be registered to use this feature.");
			return;
		}

		await ctx.replyWithChatAction("upload_video");

		const link = ctx.msg.text;
		const tempDir = tmp.dirSync({ unsafeCleanup: true });

		try {
			const videos = await downloadViaCobalt(link, tempDir.name);

			for (const video of videos) {
				try {
					ctx.logger.debug(
						"Sending cobalt video %s to %s",
						video.filePath,
						ctx.chatId
					);

					await ctx.replyWithVideo(new InputFile(video.filePath), {
						width: video.metadata.width,
						height: video.metadata.height,
						supports_streaming: true,
					});

					ctx.logger.info(
						"Cobalt video %s sent successfully to %s",
						video.filePath,
						ctx.chatId
					);
				} catch (error) {
					if (error instanceof GrammyError) {
						ctx.logger.error(error, "Error sending cobalt video");
						if (error.error_code === 413) {
							await ctx.reply("Video is too large, can't be sent.");
						} else {
							await ctx.reply("Can't download video, sorry.");
							throw error;
						}
					}
				}
			}
		} catch (error) {
			ctx.logger.error(error, "Error downloading video via cobalt");
			await ctx.reply("Can't download video, sorry.");
		} finally {
			tempDir.removeCallback();
		}
	}
);

export default composer;

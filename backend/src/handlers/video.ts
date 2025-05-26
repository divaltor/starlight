import type { Context } from "@/bot";
import { downloadVideo } from "@/services/video";
import { Composer, InputFile } from "grammy";
import tmp from "tmp";

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
		const videos = await downloadVideo(ctx.msg.text, tempDir.name);

		for (const video of videos) {
			await ctx.replyWithVideo(new InputFile(video.filePath), {
				width: video.metadata?.width,
				height: video.metadata?.height,
			});
		}

		tempDir.removeCallback();
	},
);

export default composer;

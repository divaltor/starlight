/** biome-ignore-all lint/correctness/noUndeclaredVariables: Global Bun */
import { cleanupTweetText, extractTweetId, prisma } from "@starlight/utils";
import { Composer, GrammyError, InlineKeyboard, InputFile } from "grammy";
import tmp from "tmp";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import type { FxEmbedTweet } from "@/services/fxembed/types";
import { generateTweetImage } from "@/services/tweet/tweet-image.service";
import {
	downloadVideo,
	downloadVideoFromUrl,
	type VideoInformation,
} from "@/services/video";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const feature = composer.chatType("private");

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
	(ctx) => ctx.msg.text.startsWith("https://"),
	async (ctx) => {
		if (!ctx.user) {
			await ctx.reply("You need to be registered to use this feature.");
			return;
		}

		await ctx.replyWithChatAction("upload_video");

		const link = ctx.msg.text;
		const tweetId = extractTweetId(link);
		const isTwitterLink = tweetId !== null;

		// Check if video already exists in database (only for Twitter links)
		if (isTwitterLink) {
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
		}

		const tempDir = tmp.dirSync({ unsafeCleanup: true });

		let videos: VideoInformation[] = [];
		let tweet: FxEmbedTweet | null = null;
		let videoDownloadFailed = false;

		try {
			if (isTwitterLink) {
				const [downloadResult, tweetResult] = await Promise.allSettled([
					downloadVideo(link, tempDir.name),
					fetchTweet(tweetId),
				]);

				tweet = tweetResult.status === "fulfilled" ? tweetResult.value : null;

				if (downloadResult.status === "fulfilled") {
					videos = downloadResult.value;
				} else {
					ctx.logger.warn(
						{ error: downloadResult.reason },
						"yt-dlp download failed, trying fxtwitter API fallback"
					);

					const apiVideos = tweet?.media?.videos;
					if (apiVideos && apiVideos.length > 0) {
						try {
							for (const apiVideo of apiVideos) {
								const info = await downloadVideoFromUrl(
									apiVideo.url,
									tempDir.name,
									{ width: apiVideo.width, height: apiVideo.height }
								);
								videos.push(info);
							}
						} catch (fallbackError) {
							ctx.logger.error(
								{ error: fallbackError },
								"Fallback video download also failed"
							);
							videoDownloadFailed = true;
						}
					} else {
						videoDownloadFailed = true;
					}
				}
			} else {
				videos = await downloadVideo(link, tempDir.name);
			}
		} catch (error) {
			ctx.logger.error(error, "Error downloading video");

			await ctx.reply("Can't download video, sorry.");
			return;
		}

		if (isTwitterLink && videoDownloadFailed && videos.length === 0) {
			const hasVideo = tweet?.media?.videos && tweet.media.videos.length > 0;

			if (!hasVideo && tweet) {
				ctx.logger.info(
					{ tweetId },
					"No video in tweet, generating image instead"
				);

				try {
					const result = await generateTweetImage(tweetId, "light");
					await ctx.replyWithPhoto(
						new InputFile(result.buffer, `tweet-${tweetId}.jpg`)
					);
					tempDir.removeCallback();
					return;
				} catch (imgError) {
					ctx.logger.error(imgError, "Error generating tweet image");
					await ctx.reply("Can't process this tweet, sorry.");
					tempDir.removeCallback();
					return;
				}
			}

			await ctx.reply("Can't download video, sorry.");
			tempDir.removeCallback();
			return;
		}

		const cleanedText = isTwitterLink
			? cleanupTweetText(tweet?.text)
			: undefined;

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

				if (isTwitterLink) {
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

feature.on(":video", async (ctx) => {
	const fileUniqueId = ctx.msg.video.file_unique_id;

	const video = await prisma.video.findFirst({
		where: { telegramFileUniqueId: fileUniqueId },
		orderBy: { createdAt: "desc" },
	});

	if (!video) {
		await ctx.reply("Can't find a source, sorry.");
		return;
	}

	await ctx.reply(`https://x.com/i/status/${video.tweetId}`);
});

composer.command("source").filter(
	(ctx) =>
		ctx.msg.reply_to_message === undefined ||
		ctx.msg.reply_to_message?.video === undefined,
	(ctx) => {
		ctx.reply("Please, reply to a message with a video.");
	}
);

composer.command("source").filter(
	(ctx) => ctx.msg.reply_to_message !== undefined,
	async (ctx) => {
		const video = await prisma.video.findFirst({
			where: {
				telegramFileUniqueId: ctx.msg.reply_to_message?.video
					?.file_unique_id as string,
			},
			orderBy: {
				createdAt: "desc",
			},
		});

		if (!video) {
			await ctx.reply("No source found, sorry.");
			return;
		}

		await ctx.reply(`https://x.com/i/status/${video.tweetId}`);
	}
);

export default composer;

import { cleanupTweetText, extractTweetId, prisma } from "@starlight/utils";
import { Composer, GrammyError, InlineKeyboard, InputFile } from "grammy";
import tmp from "tmp";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import type { FxEmbedTweet } from "@/services/fxembed/types";
import { generateTweetImage } from "@/services/tweet/tweet-image.service";
import { downloadVideo, downloadVideoFromUrl, type VideoInformation } from "@/services/video";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);
const chats = composer.chatType(["private", "group", "supergroup"]);

function createVideoKeyboard(
	videoId: string,
	hasDescription: boolean,
	ownerId: number,
): InlineKeyboard {
	const keyboard = new InlineKeyboard();
	if (hasDescription) {
		keyboard.text("Remove description", `video:remove_desc:${videoId}:${ownerId}`);
	} else {
		keyboard.text("Add description", `video:add_desc:${videoId}:${ownerId}`);
	}
	return keyboard;
}

async function tryDeleteMessage(ctx: Context): Promise<void> {
	try {
		await ctx.deleteMessage();
	} catch (error) {
		if (error instanceof GrammyError) {
			ctx.logger.debug(
				{ error: error.message },
				"Could not delete command message (missing permissions)",
			);
		} else {
			throw error;
		}
	}
}

async function handleVideoRequest(
	ctx: Context,
	link: string,
	ownerId: number,
	messageThreadId?: number,
): Promise<void> {
	await ctx.replyWithChatAction("upload_video");

	const tweetId = extractTweetId(link);
	const isTwitterLink = tweetId !== null;

	if (isTwitterLink) {
		const existingVideo = await prisma.video.findFirst({
			where: { tweetId },
			orderBy: { createdAt: "desc" },
		});

		if (existingVideo) {
			ctx.logger.info("Found existing video for tweet %s, sending via file_id", tweetId);

			try {
				await ctx.replyWithVideo(existingVideo.telegramFileId, {
					width: existingVideo.width ?? undefined,
					height: existingVideo.height ?? undefined,
					supports_streaming: true,
					reply_markup: existingVideo.tweetText
						? createVideoKeyboard(existingVideo.id, false, ownerId)
						: undefined,
					message_thread_id: messageThreadId,
				});

				ctx.logger.info("Existing video sent successfully to %s", ctx.chatId);
				return;
			} catch (error) {
				ctx.logger.error(
					{ error, videoId: existingVideo.id },
					"Error sending existing video, will download fresh copy",
				);
			}
		}
	}

	const tempDir = tmp.dirSync({ unsafeCleanup: true });

	try {
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
						"yt-dlp download failed, trying fxtwitter API fallback",
					);

					const apiVideos = tweet?.media?.videos;
					if (apiVideos && apiVideos.length > 0) {
						try {
							for (const apiVideo of apiVideos) {
								const info = await downloadVideoFromUrl(apiVideo.url, tempDir.name, {
									width: apiVideo.width,
									height: apiVideo.height,
								});
								videos.push(info);
							}
						} catch (fallbackError) {
							ctx.logger.error({ error: fallbackError }, "Fallback video download also failed");
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

			await ctx.reply("Can't download video, sorry.", {
				message_thread_id: messageThreadId,
			});
			return;
		}

		if (isTwitterLink && videoDownloadFailed && videos.length === 0) {
			const hasVideo = tweet?.media?.videos && tweet.media.videos.length > 0;

			if (!hasVideo && tweet) {
				ctx.logger.info({ tweetId }, "No video in tweet, generating image instead");

				try {
					const result = await generateTweetImage(tweetId, "light");
					await ctx.replyWithPhoto(new InputFile(result.buffer, `tweet-${tweetId}.jpg`), {
						message_thread_id: messageThreadId,
					});
					return;
				} catch (imgError) {
					ctx.logger.error(imgError, "Error generating tweet image");
					await ctx.reply("Can't process this tweet, sorry.", {
						message_thread_id: messageThreadId,
					});
					return;
				}
			}

			await ctx.reply("Can't download video, sorry.", {
				message_thread_id: messageThreadId,
			});
			return;
		}

		const cleanedText = isTwitterLink ? cleanupTweetText(tweet?.text) : undefined;

		for (const video of videos) {
			try {
				ctx.logger.debug("Sending video %s to %s", video.filePath, ctx.chatId);

				const videoId = Bun.randomUUIDv7();

				const sentMessage = await ctx.replyWithVideo(new InputFile(video.filePath), {
					width: video.metadata?.width,
					height: video.metadata?.height,
					supports_streaming: true,
					reply_markup: cleanedText ? createVideoKeyboard(videoId, false, ownerId) : undefined,
					message_thread_id: messageThreadId,
				});

				if (isTwitterLink) {
					await prisma.video.create({
						data: {
							id: videoId,
							userId: ctx.user!.id,
							tweetId,
							tweetText: cleanedText,
							telegramFileId: sentMessage.video.file_id,
							telegramFileUniqueId: sentMessage.video.file_unique_id,
							width: sentMessage.video.width,
							height: sentMessage.video.height,
						},
					});
				}

				ctx.logger.info("Video %s sent successfully to %s", video.filePath, ctx.chatId);
			} catch (error) {
				if (error instanceof GrammyError) {
					ctx.logger.error(error, "Error sending video");
					if (error.error_code === 413) {
						await ctx.reply("Video is too large, can't be sent.", {
							message_thread_id: messageThreadId,
						});
					} else {
						await ctx.reply("Can't download video, sorry.", {
							message_thread_id: messageThreadId,
						});
						throw error;
					}
				}
			}
		}
	} finally {
		tempDir.removeCallback();
	}
}

privateChat.on(":text").filter(
	(ctx) => ctx.msg.text.startsWith("https://"),
	async (ctx) => {
		await handleVideoRequest(ctx, ctx.msg.text, ctx.from.id);
	},
);

groupChat.command(["v", "video"]).filter(
	(ctx) => !ctx.match.trim().startsWith("https://"),
	async (ctx) => {
		await tryDeleteMessage(ctx);
		await ctx.reply("Не позорься и скинь нормальную ссылку", {
			message_thread_id: ctx.msg.message_thread_id,
		});
	},
);

groupChat.command(["v", "video"]).filter(
	(ctx) => ctx.match.trim().startsWith("https://"),
	async (ctx) => {
		await tryDeleteMessage(ctx);
		await handleVideoRequest(ctx, ctx.match.trim(), ctx.from.id, ctx.msg.message_thread_id);
	},
);

chats.callbackQuery(/^video:(add_desc|remove_desc):([^:]+):(\d+)$/, async (ctx) => {
	const action = ctx.match[1];
	const videoId = ctx.match[2];
	const ownerId = Number(ctx.match[3]);

	if (ctx.from.id !== ownerId) {
		await ctx.answerCallbackQuery({
			text: "Может по голове себе постучишь?",
			show_alert: true,
		});
		return;
	}

	await ctx.answerCallbackQuery();

	const video = await prisma.video.findUnique({
		where: { id: videoId },
	});

	if (!video) {
		return;
	}

	const showDescription = action === "add_desc";
	const caption = showDescription ? (video.tweetText ?? undefined) : undefined;

	try {
		await ctx.editMessageCaption({
			caption,
			reply_markup: createVideoKeyboard(videoId, showDescription, ownerId),
		});
	} catch (error) {
		if (error instanceof GrammyError) {
			ctx.logger.warn({ error, videoId }, "Failed to edit message, resending video");

			await ctx.replyWithVideo(video.telegramFileId, {
				width: video.width ?? undefined,
				height: video.height ?? undefined,
				supports_streaming: true,
				caption,
				reply_markup: createVideoKeyboard(videoId, showDescription, ownerId),
				message_thread_id: ctx.msg?.message_thread_id,
			});
		} else {
			throw error;
		}
	}
});

privateChat.on(":video", async (ctx) => {
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
	(ctx) => ctx.msg.reply_to_message === undefined || ctx.msg.reply_to_message?.video === undefined,
	(ctx) => {
		ctx.reply("Please, reply to a message with a video.");
	},
);

composer.command("source").filter(
	(ctx) => ctx.msg.reply_to_message !== undefined,
	async (ctx) => {
		const video = await prisma.video.findFirst({
			where: {
				telegramFileUniqueId: ctx.msg.reply_to_message?.video?.file_unique_id as string,
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
	},
);

export default composer;

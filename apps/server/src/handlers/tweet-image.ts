import { env, extractTweetId, isTwitterUrl } from "@starlight/utils";
import {
	Composer,
	GrammyError,
	InlineKeyboard,
	InlineQueryResultBuilder,
	InputFile,
} from "grammy";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import { renderTweetImage, type TweetData } from "@/services/render";
import {
	generateTweetImage,
	type Theme,
} from "@/services/tweet/tweet-image.service";
import { s3 } from "@/storage";
import type { Context } from "@/types";

function stripLeadingMention(text: string, username: string): string {
	const mentionPattern = new RegExp(`^@${username}\\s*`, "i");
	return text.replace(mentionPattern, "").trim();
}

const MAX_REPLY_CHAIN_DEPTH = 3;

type ReplyChainResult = {
	chain: TweetData[];
	hasMore: boolean;
};

async function fetchReplyChain(
	tweetId: string,
	depth = 0
): Promise<ReplyChainResult> {
	if (depth >= MAX_REPLY_CHAIN_DEPTH) {
		return { chain: [], hasMore: true };
	}

	const tweet = await fetchTweet(tweetId);
	if (!tweet) {
		return { chain: [], hasMore: false };
	}

	const tweetData: TweetData = {
		authorName: tweet.author.name,
		authorUsername: tweet.author.screen_name,
		authorAvatarUrl: tweet.author.avatar_url,
		text: tweet.text,
		createdAt: new Date(tweet.created_timestamp * 1000),
		media: tweet.media
			? {
					photos: tweet.media.photos,
				}
			: null,
		likes: tweet.likes,
		retweets: tweet.retweets,
		replies: tweet.replies,
	};

	if (tweet.replying_to_status) {
		const parentResult = await fetchReplyChain(
			tweet.replying_to_status,
			depth + 1
		);
		return {
			chain: [...parentResult.chain, tweetData],
			hasMore: parentResult.hasMore,
		};
	}

	return { chain: [tweetData], hasMore: false };
}

const composer = new Composer<Context>();
const groupChat = composer.chatType(["group", "supergroup"]);

function createThemeKeyboard(
	tweetId: string,
	currentTheme: Theme,
	userId: number
): InlineKeyboard {
	const nextTheme = currentTheme === "dark" ? "light" : "dark";
	const buttonText = currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";

	return new InlineKeyboard().text(
		buttonText,
		`tweet_img:toggle:${tweetId}:${nextTheme}:${userId}`
	);
}

async function tryDeleteMessage(ctx: Context): Promise<void> {
	try {
		await ctx.deleteMessage();
	} catch (error) {
		if (error instanceof GrammyError) {
			ctx.logger.debug(
				{ error: error.message },
				"Could not delete user message (missing permissions)"
			);
		} else {
			throw error;
		}
	}
}

groupChat.command("q").filter(
	(ctx) => ctx.match.trim() !== "" && extractTweetId(ctx.match.trim()) === null,
	async (ctx) => {
		ctx.logger.debug(
			{ userId: ctx.from.id, input: ctx.match.trim() },
			"Invalid tweet URL provided"
		);
		await ctx.reply("Please provide a valid tweet link");
	}
);

groupChat.command("q").filter(
	(ctx) => extractTweetId(ctx.match.trim()) !== null,
	async (ctx) => {
		const tweetId = extractTweetId(ctx.match.trim()) as string;

		ctx.logger.info({ userId: ctx.from.id, tweetId }, "Processing /q command");

		await ctx.replyWithChatAction("upload_photo");

		try {
			const result = await generateTweetImage(tweetId, "light");

			ctx.logger.debug({ tweetId }, "Tweet image generated successfully");

			await ctx.replyWithPhoto(
				new InputFile(result.buffer, `tweet-${tweetId}.jpg`),
				{
					caption: `https://x.com/i/status/${tweetId}`,
					reply_markup: createThemeKeyboard(tweetId, "light", ctx.from.id),
					message_thread_id: ctx.msg.message_thread_id,
				}
			);

			await tryDeleteMessage(ctx);
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

		ctx.logger.info(
			{ userId: ctx.from.id, query, tweetId },
			"Processing inline query for tweet"
		);

		if (!tweetId) {
			ctx.logger.debug(
				{ query },
				"Failed to extract tweet ID from inline query"
			);
			await ctx.answerInlineQuery([]);
			return;
		}

		try {
			const tweet = await fetchTweet(tweetId);

			if (!tweet) {
				ctx.logger.warn({ tweetId }, "Tweet not found for inline query");
				await ctx.answerInlineQuery([
					InlineQueryResultBuilder.article(
						`tweet-not-found:${tweetId}`,
						"Tweet not found"
					).text("Could not fetch this tweet. It may be private or deleted."),
				]);
				return;
			}

			let replyChain: TweetData[] = [];
			let hasMoreInChain = false;

			if (tweet.replying_to_status) {
				const chainResult = await fetchReplyChain(tweet.replying_to_status);
				replyChain = chainResult.chain;
				hasMoreInChain = chainResult.hasMore;
			}

			const tweetText =
				tweet.replying_to && replyChain.length > 0
					? stripLeadingMention(tweet.text, tweet.replying_to)
					: tweet.text;

			const tweetData: TweetData = {
				authorName: tweet.author.name,
				authorUsername: tweet.author.screen_name,
				authorAvatarUrl: tweet.author.avatar_url,
				text: tweetText,
				createdAt: new Date(tweet.created_timestamp * 1000),
				media: tweet.media
					? {
							photos: tweet.media.photos,
						}
					: null,
				likes: tweet.likes,
				retweets: tweet.retweets,
				replies: tweet.replies,
				replyChain,
				hasMoreInChain,
				quote: tweet.quote
					? {
							authorName: tweet.quote.author.name,
							authorUsername: tweet.quote.author.screen_name,
							authorAvatarUrl: tweet.quote.author.avatar_url,
							text: tweet.quote.text,
							createdAt: new Date(tweet.quote.created_timestamp * 1000),
							media: tweet.quote.media
								? {
										photos: tweet.quote.media.photos,
									}
								: null,
							likes: tweet.quote.likes,
							retweets: tweet.quote.retweets,
							replies: tweet.quote.replies,
						}
					: null,
			};

			const [lightResult, darkResult] = await Promise.all([
				renderTweetImage(tweetData, "light"),
				renderTweetImage(tweetData, "dark"),
			]);

			const lightS3Path = `tweets/${tweetId}/light.jpg`;
			const darkS3Path = `tweets/${tweetId}/dark.jpg`;

			await Promise.all([
				s3.write(lightS3Path, lightResult.buffer, { type: "image/jpeg" }),
				s3.write(darkS3Path, darkResult.buffer, { type: "image/jpeg" }),
			]);

			ctx.logger.debug(
				{ tweetId, lightS3Path, darkS3Path },
				"Uploaded tweet images to S3"
			);

			const lightUrl = `${env.BASE_CDN_URL}/${lightS3Path}`;
			const darkUrl = `${env.BASE_CDN_URL}/${darkS3Path}`;

			const results = [
				InlineQueryResultBuilder.photo(`tweet:${tweetId}:light`, lightUrl, {
					thumbnail_url: lightUrl,
					caption: `https://x.com/i/status/${tweetId}`,
					photo_width: lightResult.width,
					photo_height: lightResult.height,
				}),
				InlineQueryResultBuilder.photo(`tweet:${tweetId}:dark`, darkUrl, {
					thumbnail_url: darkUrl,
					caption: `https://x.com/i/status/${tweetId}`,
					photo_width: darkResult.width,
					photo_height: darkResult.height,
				}),
			];

			await ctx.answerInlineQuery(results, {
				cache_time: 300,
			});

			ctx.logger.info({ tweetId }, "Inline query answered successfully");
		} catch (error) {
			ctx.logger.error(
				{ error, tweetId },
				"Failed to generate inline tweet images"
			);
			await ctx.answerInlineQuery([]);
		}
	}
);

groupChat.callbackQuery(
	/^tweet_img:toggle:(\d+):(light|dark):(\d+)$/,
	async (ctx) => {
		const match = ctx.match;

		if (!match) {
			ctx.logger.debug("Callback query without match");
			await ctx.answerCallbackQuery();
			return;
		}

		// biome-ignore lint/style/noNonNullAssertion: We validate it on filter level
		const tweetId = match.at(1)!;
		const newTheme = match.at(2) as Theme;
		const ownerId = match.at(3);

		if (ctx.from.id !== Number(ownerId)) {
			await ctx.answerCallbackQuery({
				text: "Only the person who requested this image can change the theme",
				show_alert: true,
			});
			return;
		}

		ctx.logger.info(
			{ userId: ctx.from.id, tweetId, newTheme },
			"Processing theme toggle callback"
		);

		await ctx.answerCallbackQuery({
			text: `Generating ${newTheme} theme...`,
		});

		try {
			const result = await generateTweetImage(tweetId, newTheme);

			ctx.logger.debug({ tweetId, newTheme }, "Theme toggle image generated");

			await ctx.editMessageMedia(
				{
					type: "photo",
					media: new InputFile(result.buffer, `tweet-${tweetId}.jpg`),
					// biome-ignore lint/suspicious/noDuplicateObjectKeys: Man...
					caption: ctx.msg?.caption,
				},
				{
					reply_markup: createThemeKeyboard(tweetId, newTheme, ctx.from.id),
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

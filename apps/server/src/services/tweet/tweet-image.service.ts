import type { Api, RawApi } from "grammy";
import { InputFile } from "grammy";
import { logger } from "@/logger";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import { renderTweetImage, type TweetData } from "@/services/render";

export type Theme = "light" | "dark";

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

export type TweetImageResult = {
	fileId: string;
	fileUniqueId: string;
	messageId: number;
	width: number;
	height: number;
};

export async function generateTweetImage(
	tweetId: string,
	api: Api<RawApi>,
	chatId: string | number,
	theme: Theme = "light"
): Promise<TweetImageResult> {
	const tweet = await fetchTweet(tweetId);

	if (!tweet) {
		logger.warn({ tweetId }, "Could not fetch tweet");
		throw new Error("Tweet not found");
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
	};

	logger.debug({ tweetId, theme }, "Rendering tweet image");

	const renderResult = await renderTweetImage(tweetData, theme);

	logger.debug({ tweetId, theme }, "Sending tweet image to Telegram");

	const message = await api.sendPhoto(
		chatId,
		new InputFile(renderResult.buffer, `tweet-${tweetId}.jpg`)
	);

	const photo = message.photo;
	const largest = photo.at(-1);

	if (!largest) {
		throw new Error("No photo in response");
	}

	return {
		fileId: largest.file_id,
		fileUniqueId: largest.file_unique_id,
		messageId: message.message_id,
		width: renderResult.width,
		height: renderResult.height,
	};
}

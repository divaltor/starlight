import { logger } from "@/logger";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import {
	type RenderResult,
	renderTweetImage,
	type TweetData,
} from "@/services/render";

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
		createdAt: new Date(tweet.created_timestamp * 1000),
		media: tweet.media
			? {
					photos: tweet.media.photos,
					videos: tweet.media.videos?.map((v) => ({
						thumbnailUrl: v.thumbnail_url,
						width: v.width,
						height: v.height,
						type: v.type,
					})),
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

export type TweetImageResult = RenderResult;

export async function prepareTweetData(tweetId: string): Promise<TweetData> {
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

	return {
		authorName: tweet.author.name,
		authorUsername: tweet.author.screen_name,
		authorAvatarUrl: tweet.author.avatar_url,
		text: tweetText,
		createdAt: new Date(tweet.created_timestamp * 1000),
		media: tweet.media
			? {
					photos: tweet.media.photos,
					videos: tweet.media.videos?.map((v) => ({
						thumbnailUrl: v.thumbnail_url,
						width: v.width,
						height: v.height,
						type: v.type,
					})),
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
								videos: tweet.quote.media.videos?.map((v) => ({
									thumbnailUrl: v.thumbnail_url,
									width: v.width,
									height: v.height,
									type: v.type,
								})),
							}
						: null,
					likes: tweet.quote.likes,
					retweets: tweet.quote.retweets,
					replies: tweet.quote.replies,
				}
			: null,
	};
}

export async function generateTweetImage(
	tweetId: string,
	theme: Theme = "light"
): Promise<TweetImageResult> {
	const tweetData = await prepareTweetData(tweetId);

	logger.debug({ tweetId, theme }, "Rendering tweet image");

	return renderTweetImage(tweetData, theme);
}

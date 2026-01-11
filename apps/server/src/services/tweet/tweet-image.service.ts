import type { Api, RawApi } from "grammy";
import { InputFile } from "grammy";
import { logger } from "@/logger";
import { fetchTweet } from "@/services/fxembed/fxembed.service";
import { renderTweetImage, type TweetData } from "@/services/render";

export type Theme = "light" | "dark";

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

	let replyToData: TweetData | null = null;
	if (tweet.replying_to_status) {
		const parentTweet = await fetchTweet(tweet.replying_to_status);
		if (parentTweet) {
			replyToData = {
				authorName: parentTweet.author.name,
				authorUsername: parentTweet.author.screen_name,
				authorAvatarUrl: parentTweet.author.avatar_url,
				text: parentTweet.text,
				media: parentTweet.media
					? {
							photos: parentTweet.media.photos,
						}
					: null,
				likes: parentTweet.likes,
				retweets: parentTweet.retweets,
				replies: parentTweet.replies,
			};
		} else {
			logger.warn(
				{ parentTweetId: tweet.replying_to_status },
				"Could not fetch parent tweet"
			);
		}
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
		replyTo: replyToData,
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

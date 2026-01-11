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

	logger.debug({ tweetId, theme }, "Rendering tweet image");

	const renderResult = await renderTweetImage(tweetData, theme);

	logger.debug({ tweetId, theme }, "Sending tweet image to Telegram");

	const message = await api.sendPhoto(
		chatId,
		new InputFile(renderResult.buffer, `tweet-${tweetId}.png`)
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

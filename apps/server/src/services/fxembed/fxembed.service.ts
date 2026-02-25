import { logger } from "@/logger";
import type { FxEmbedResponse, FxEmbedTweet } from "./types";

const FXEMBED_BASE_URL = "https://api.fxtwitter.com";
const FETCH_TIMEOUT_MS = 5000;
const USER_AGENT = "StarlightBot/1.0 (Telegram Bot)";

export async function fetchTweet(tweetId: string): Promise<FxEmbedTweet | null> {
	const url = `${FXEMBED_BASE_URL}/status/${tweetId}`;

	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			logger.warn({ status: response.status, tweetId }, "FxEmbed API error");
			return null;
		}

		const data = (await response.json()) as FxEmbedResponse;

		if (data.code !== 200 || !data.tweet) {
			logger.warn({ code: data.code, message: data.message, tweetId }, "FxEmbed returned non-200");
			return null;
		}

		return data.tweet;
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			logger.warn({ tweetId }, "FxEmbed fetch timeout");
		} else {
			logger.error({ error, tweetId }, "FxEmbed fetch failed");
		}
		return null;
	}
}

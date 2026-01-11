const TWITTER_URL_REGEX =
	/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com)\/\w+\/status\/(\d+).+/i;

export function extractTweetId(url: string): string | null {
	const match = url.match(TWITTER_URL_REGEX);
	return match?.at(1) ?? null;
}

export function isTwitterUrl(text: string): boolean {
	return TWITTER_URL_REGEX.test(text);
}

export function normalizeTwitterUrl(
	tweetId: string,
	username?: string
): string {
	return `https://x.com/${username ?? "i"}/status/${tweetId}`;
}

export function cleanupTweetText(text: string | undefined): string | undefined {
	if (!text) {
		return;
	}

	return (
		text
			// Remove all hashtags
			.replace(/#[\p{L}0-9_]+/gu, "")
			// Remove all URLs
			.replace(/https?:\/\/\S+/g, "")
			.trim()
	);
}

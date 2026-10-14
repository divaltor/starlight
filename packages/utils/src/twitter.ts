const TWITTER_URL_REGEX =
  /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com)\/\w+\/status\/(?<tweetId>\d+)(?:.+)?/iu;

export function extractTweetId(url: string): string | null {
  const match = TWITTER_URL_REGEX.exec(url);

  return match?.groups?.tweetId ?? null;
}

export function isTwitterUrl(text: string): boolean {
  return TWITTER_URL_REGEX.test(text);
}

export function cleanupTweetText(text: string | undefined): string | undefined {
  if (text === undefined || text === "") {
    return undefined;
  }

  return (
    text
      // Remove all hashtags
      .replaceAll(/#[\p{L}0-9_]+/gu, "")
      // Remove all URLs
      .replaceAll(/https?:\/\/\S+/gu, "")
      .trim()
  );
}

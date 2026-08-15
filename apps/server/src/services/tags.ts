import type { Tweet } from "@the-convocation/twitter-scraper";

export const normalizeTags = (tags: readonly string[]): string[] => {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		const value = tag.trim();
		if (value && !seen.has(value)) {
			seen.add(value);
			normalized.push(value);
		}
	}
	return normalized;
};

export const normalizeCollectorTags = (
	provider: string,
	tags: unknown,
	providerPayload: object,
): string[] => {
	if (Array.isArray(tags)) {
		return normalizeTags(tags.filter((tag): tag is string => typeof tag === "string"));
	}
	if (tags !== undefined) {
		return [];
	}
	if (provider !== "twitter") {
		return [];
	}
	const hashtags = (providerPayload as { hashtags?: unknown }).hashtags;
	return Array.isArray(hashtags)
		? normalizeTags(hashtags.filter((tag): tag is string => typeof tag === "string"))
		: [];
};

export const normalizeTwitterTags = (tweet: Pick<Tweet, "hashtags">): string[] =>
	normalizeTags(tweet.hashtags);

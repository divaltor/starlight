import { normalizeTags } from "@/services/tag-normalization";

export const normalizeCollectorTags = (
	provider: string,
	tags: unknown,
	providerPayload: object,
): string[] => {
	if (Array.isArray(tags)) {
		return normalizeTags(tags.filter((tag): tag is string => typeof tag === "string"));
	}
	if (tags !== undefined || provider !== "twitter") {
		return [];
	}
	const hashtags = (providerPayload as { hashtags?: unknown }).hashtags;
	return Array.isArray(hashtags)
		? normalizeTags(hashtags.filter((tag): tag is string => typeof tag === "string"))
		: [];
};

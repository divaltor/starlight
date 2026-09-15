import { normalizeTags } from "@/services/tag-normalization";

interface ProviderPayload {
  hashtags?: unknown;
  starlightMediaType?: unknown;
}

export const normalizeCollectorTags = (
  provider: string,
  tags: string[] | undefined,
  providerPayload: ProviderPayload,
): string[] => {
  if (tags) {
    return normalizeTags(tags);
  }
  if (tags !== undefined || provider !== "twitter") {
    return [];
  }
  const { hashtags } = providerPayload as { hashtags?: unknown };
  return Array.isArray(hashtags) ? normalizeTags(hashtags.filter((tag): tag is string => typeof tag === "string")) : [];
};

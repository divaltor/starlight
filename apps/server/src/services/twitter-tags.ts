import type { Tweet } from "@the-convocation/twitter-scraper";
import { normalizeTags } from "@/services/tag-normalization";

export const normalizeTwitterTags = (tweet: Pick<Tweet, "hashtags">): string[] =>
	normalizeTags(tweet.hashtags);

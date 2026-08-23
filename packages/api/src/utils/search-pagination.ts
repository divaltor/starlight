import type { SearchResult } from "../types/tweets";

export const paginateSearchResults = (results: SearchResult[], limit: number) => {
  const selectedPosts = new Set<string>();
  const rows: SearchResult[] = [];
  let hasNextPage = false;
  let lastPost: Pick<SearchResult, "final_score" | "tweet_id"> | undefined;

  for (const result of results) {
    const isDuplicate = selectedPosts.has(result.tweet_id);
    const hasReachedLimit = selectedPosts.size >= limit;

    if (isDuplicate) {
      rows.push(result);
    } else if (hasReachedLimit) {
      hasNextPage = true;
    } else {
      selectedPosts.add(result.tweet_id);
      rows.push(result);
      lastPost = result;
    }
  }

  return { hasNextPage, lastPost, rows };
};

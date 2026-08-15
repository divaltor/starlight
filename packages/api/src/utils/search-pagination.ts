import type { SearchResult } from "../types/tweets";

export const paginateSearchResults = (results: SearchResult[], limit: number) => {
	const selectedPosts = new Set<string>();
	const rows: SearchResult[] = [];
	let hasNextPage = false;
	let lastPost: Pick<SearchResult, "final_score" | "tweet_id"> | undefined;

	for (const result of results) {
		const key = result.tweet_id;
		if (selectedPosts.has(key)) {
			rows.push(result);
			continue;
		}
		if (selectedPosts.size >= limit) {
			hasNextPage = true;
			continue;
		}
		selectedPosts.add(key);
		rows.push(result);
		lastPost = result;
	}

	return { hasNextPage, lastPost, rows };
};

import type { SearchResult } from "../types/tweets";

export const paginateSearchResults = (results: SearchResult[], limit: number) => {
	const selectedPosts = new Set<string>();
	const rows: SearchResult[] = [];
	let hasNextPage = false;
	let lastPost:
		| Pick<SearchResult, "final_score" | "post_provider" | "post_id" | "user_id">
		| undefined;

	for (const result of results) {
		const key = `${result.post_provider}:${result.post_id}:${result.user_id}`;
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

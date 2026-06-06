import { tool } from "ai";
import { z } from "zod";
import { searchWeb } from "@/services/search";
import type { SearchToolResultPart } from "@/types";

export const SEARCH_WEB_TOOL_ID = "search_web";

export function createSearchWebTool(searchContext: string[], messageParts: SearchToolResultPart[]) {
	return tool({
		description:
			"Search the live web when current or external information is needed. Returns up to 3 pages with source URLs. Use at most 2 searches, and cite useful URLs in your response.",
		inputSchema: z.object({
			query: z.string().min(3).max(300).describe("A concise, self-contained web search query."),
		}),
		execute: async ({ query }) => {
			const results = await searchWeb(query);
			const compactResults = results.slice(0, 3).map((result, index) => ({
				content: result.content.slice(0, 2_000),
				index: index + 1,
				publishedDate: result.publishedDate ?? undefined,
				source: result.source,
				title: result.title ?? undefined,
				url: result.url,
			}));

			if (compactResults.length > 0) {
				messageParts.push({
					type: "tool",
					toolName: SEARCH_WEB_TOOL_ID,
					input: { query },
					output: { results: compactResults },
				});

				searchContext.push(
					`Search query: ${query}\n${compactResults
						.map(
							(result) =>
								`${result.index}. ${result.title ?? result.url}\nURL: ${result.url}\nSource: ${result.source}${result.publishedDate ? `\nPublished: ${result.publishedDate}` : ""}\n${result.content}`,
						)
						.join("\n\n")}`,
				);
			}

			return { results: compactResults };
		},
	});
}

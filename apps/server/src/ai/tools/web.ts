import { tool } from "ai";
import { z } from "zod";
import { lookupWebPage, searchWeb } from "@/services/web";
import { FetchPageToolResultPart, SearchToolResultPart, type ToolResultPart } from "@/types";

export const WEB_LOOKUP_TOOL_ID = "web_lookup";

const MAX_PAGE_CONTENT_LENGTH = 6_000;
const MAX_SEARCH_CONTENT_LENGTH = 2_000;
const MAX_SEARCH_RESULTS = 3;

function looksLikeUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value.trim());
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export function createWebLookupTool(messageParts: ToolResultPart[]) {
	return tool({
		description:
			'Access the web. Use mode="url" only to read a web page whose URL is explicitly written in conversation message text or a caption. Use mode="search" only to discover sources or verify current facts when there is no page URL to read. Never use attachment or media URLs.',
		inputSchema: z.object({
			mode: z.enum(["url", "search"]),
			url: z.url().optional().describe('Required when mode="url".'),
			query: z.string().min(3).max(300).optional().describe('Required when mode="search".'),
		}),
		execute: async ({ mode, url, query }) => {
			const lookupTarget = mode === "url" ? url : query && looksLikeUrl(query) ? query : undefined;

			if (lookupTarget) {
				const page = await lookupWebPage(lookupTarget);
				const compactPage = page
					? { ...page, content: page.content.slice(0, MAX_PAGE_CONTENT_LENGTH) }
					: null;

				if (compactPage) {
					messageParts.push(
						new FetchPageToolResultPart({
							type: "tool",
							toolName: "fetch_page",
							input: { url: lookupTarget },
							output: { page: compactPage },
						}),
					);
				}

				return { page: compactPage };
			}

			if (mode === "url" || !query) {
				return { page: null };
			}

			const results = await searchWeb(query);
			const compactResults = results.slice(0, MAX_SEARCH_RESULTS).map((result, index) => ({
				content: result.content.slice(0, MAX_SEARCH_CONTENT_LENGTH),
				index: index + 1,
				publishedDate: result.publishedDate ?? undefined,
				title: result.title ?? undefined,
				url: result.url,
			}));

			if (compactResults.length > 0) {
				messageParts.push(
					new SearchToolResultPart({
						type: "tool",
						toolName: "search_web",
						input: { query },
						output: { results: compactResults },
					}),
				);
			}

			return { results: compactResults };
		},
	});
}

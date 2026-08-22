import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { lookupWebPage, searchWeb } from "@/services/web";
import { FetchPageToolResultPart, SearchToolResultPart } from "@/types";
import type { ToolResultPart } from "@/types";

export const WEB_LOOKUP_TOOL_ID = "web_lookup";

const MAX_PAGE_CONTENT_LENGTH = 6000;
const MAX_SEARCH_CONTENT_LENGTH = 2000;
const MAX_SEARCH_RESULTS = 5;

function looksLikeUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value.trim());
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

// The SDK's exported Tool type keeps the signature nameable in declaration
// output; full inference references internal AI SDK types that cannot be.
export function createWebLookupTool(messageParts: ToolResultPart[]): Tool {
	const inputSchema = z.object({
		mode: z.enum(["url", "search"]),
		url: z.url().optional().describe('Required when mode="url".'),
		query: z.string().min(3).max(300).optional().describe('Required when mode="search".'),
	});

	return tool({
		description:
			'Access the web. Use mode="url" only to read a web page whose URL is explicitly written in conversation message text or a caption. Use mode="search" only to discover sources or verify current facts when there is no page URL to read. Never use attachment or media URLs.',
		inputSchema,
		execute: async ({ mode, url, query }) => {
			const queryLooksLikeUrl = Boolean(query && looksLikeUrl(query));

			let lookupTarget: string | undefined;
			if (mode === "url") {
				lookupTarget = url;
			} else if (queryLooksLikeUrl && query) {
				lookupTarget = query;
			}

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

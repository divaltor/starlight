import { tool } from "ai";
import { z } from "zod";
import { extractMarkdown } from "@/services/markdown";
import { searchWeb } from "@/services/search";
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

export function createWebLookupTool(
	messageParts: ToolResultPart[],
	{ searchEnabled }: { searchEnabled: boolean },
) {
	const modes = searchEnabled ? (["url", "search"] as const) : (["url"] as const);

	const description = searchEnabled
		? 'Access the web. Use mode="url" to read a specific page whose URL appears anywhere in the conversation (including follow-ups like "what\'s there?" or "summarize it" about a link sent earlier). Use mode="search" only to discover sources or verify current facts when there is no URL to read. Never search for a URL just to read it, and never do both for the same thing.'
		: 'Read a specific web page whose URL appears anywhere in the conversation (including follow-ups like "what\'s there?" or "summarize it" about a link sent earlier). Always use mode="url" with that exact URL.';

	return tool({
		description,
		inputSchema: z.object({
			mode: z
				.enum(modes)
				.describe(
					searchEnabled
						? 'Use "url" when a specific URL is available anywhere in the conversation; use "search" only to discover sources when there is no URL.'
						: 'Always "url": read the page at the provided URL.',
				),
			url: z.url().optional().describe('Required when mode="url". The exact page URL to read.'),
			objective: z
				.string()
				.min(3)
				.max(5000)
				.optional()
				.describe(
					'When mode="url", describe what information to extract from the page. Omit only when the entire page is needed.',
				),
			query: z
				.string()
				.min(3)
				.max(300)
				.optional()
				.describe('Required when mode="search". A concise, self-contained web search query.'),
		}),
		execute: async ({ mode, url, objective, query }) => {
			// Route to fetch when we have a concrete URL — either via mode="url",
			// or when the model put a URL into the search query by mistake.
			const fetchTarget = mode === "url" ? url : query && looksLikeUrl(query) ? query : undefined;

			if (fetchTarget) {
				const page = await extractMarkdown(fetchTarget, objective);

				if (!page) {
					return { page: null };
				}

				const compactPage = {
					content: page.markdown.slice(0, MAX_PAGE_CONTENT_LENGTH),
					source: page.source,
					url: page.url,
				};

				messageParts.push(
					new FetchPageToolResultPart({
						type: "tool",
						toolName: "fetch_page",
						input: { url: fetchTarget, objective },
						output: { page: compactPage },
					}),
				);

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
				source: result.source,
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

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

export function createWebLookupTool(messageParts: ToolResultPart[]) {
	const description =
		'Access the web. Use mode="url" only to read a web page whose URL is explicitly written in conversation message text or a caption (including follow-ups like "what\'s there?" or "summarize it" about a link sent earlier). Attachment, file, image, video, and other media URLs are not page links and must never be passed to this tool. Use mode="search" only to discover sources or verify current facts when there is no page URL to read. Never search for a URL just to read it, and never do both for the same thing.';

	return tool({
		description,
		inputSchema: z.object({
			mode: z
				.enum(["url", "search"])
				.describe(
					'Use "url" when a page URL is explicitly written in message text or a caption; use "search" only to discover sources when there is no page URL. Never use attachment or media URLs.',
				),
			url: z
				.url()
				.optional()
				.describe(
					'Required when mode="url". The exact page URL copied from message text or a caption, never an attachment, file, image, video, or other media URL.',
				),
			query: z
				.string()
				.min(3)
				.max(300)
				.optional()
				.describe('Required when mode="search". A concise, self-contained web search query.'),
		}),
		execute: async ({ mode, url, query }) => {
			// Route to fetch when we have a concrete URL — either via mode="url",
			// or when the model put a URL into the search query by mistake.
			const fetchTarget = mode === "url" ? url : query && looksLikeUrl(query) ? query : undefined;

			if (fetchTarget) {
				const page = await extractMarkdown(fetchTarget);

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
						input: { url: fetchTarget },
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

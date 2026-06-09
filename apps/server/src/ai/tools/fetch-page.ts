import { tool } from "ai";
import { z } from "zod";
import { extractMarkdown } from "@/services/markdown";
import { FetchPageToolResultPart, type ToolResultPart } from "@/types";

export const FETCH_PAGE_TOOL_ID = "fetch_page";

const MAX_PAGE_CONTENT_LENGTH = 6_000;

export function createFetchPageTool(messageParts: ToolResultPart[]) {
	return tool({
		description:
			"Fetch and read a specific URL that the user already provided. Use this instead of web search when a message contains a link and the answer depends on that page's contents. Do not use for discovering pages or answering broad/current questions without a specific URL.",
		inputSchema: z.object({
			url: z.url().describe("The page URL to fetch and summarize/read."),
		}),
		execute: async ({ url }) => {
			const page = await extractMarkdown(url);

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
					toolName: FETCH_PAGE_TOOL_ID,
					input: { url },
					output: { page: compactPage },
				}),
			);

			return { page: compactPage };
		},
	});
}

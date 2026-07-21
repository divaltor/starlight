import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const WEB_SEARCH_TOOL_ID = "web_search";
export const WEB_FETCH_TOOL_ID = "web_fetch";

const MAX_SEARCH_RESULTS = 3;
const MAX_FETCH_CONTENT_TOKENS = 6_000;

export function createOpenRouterWebTools(provider: OpenRouterProvider): ToolSet {
	return {
		[WEB_SEARCH_TOOL_ID]: provider.tools.webSearch({
			engine: "exa",
			maxResults: MAX_SEARCH_RESULTS,
		}),
		// OpenRouter provider 3.0 exposes webSearch but not webFetch yet. Its provider-tool
		// mapper still supports the documented openrouter.web_fetch ID and arguments.
		[WEB_FETCH_TOOL_ID]: tool({
			type: "provider",
			id: "openrouter.web_fetch",
			isProviderExecuted: false,
			args: {
				parameters: {
					engine: "exa",
					max_content_tokens: MAX_FETCH_CONTENT_TOKENS,
					max_uses: 1,
				},
			},
			inputSchema: z.unknown(),
		}),
	};
}

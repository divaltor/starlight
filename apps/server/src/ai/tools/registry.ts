import type { generateText, Tool, ToolSet } from "ai";
import { createFetchPageTool, FETCH_PAGE_TOOL_ID } from "@/ai/tools/fetch-page";
import { isSearchEnabled } from "@/services/search";
import { createSearchWebTool, SEARCH_WEB_TOOL_ID } from "@/ai/tools/search-web";
import type { ToolResultPart } from "@/types";

type PrepareStep = NonNullable<Parameters<typeof generateText>[0]["prepareStep"]>;

interface ToolRegistryItem {
	id: string;
	isAvailable: () => boolean;
	create: (searchContext: string[], messageParts: ToolResultPart[]) => Tool;
}

export function createAvailableTools() {
	const searchContext: string[] = [];
	const messageParts: ToolResultPart[] = [];
	const registry = [
		{
			id: FETCH_PAGE_TOOL_ID,
			isAvailable: () => true,
			create: (_searchContext, messageParts) => createFetchPageTool(messageParts),
		},
		{
			id: SEARCH_WEB_TOOL_ID,
			isAvailable: isSearchEnabled,
			create: createSearchWebTool,
		},
	] satisfies ToolRegistryItem[];

	const tools = registry.reduce<ToolSet>((availableTools, item) => {
		if (item.isAvailable()) {
			availableTools[item.id] = item.create(searchContext, messageParts);
		}

		return availableTools;
	}, {});

	const prepareStep: PrepareStep = ({ steps }) => {
		const usedToolNames = new Set(
			steps.flatMap((step) => step.toolCalls.map((toolCall) => toolCall.toolName)),
		);
		const activeTools = Object.keys(tools).filter((toolName) => !usedToolNames.has(toolName));

		return activeTools.length === Object.keys(tools).length ? undefined : { activeTools };
	};

	return {
		tools: Object.keys(tools).length > 0 ? tools : undefined,
		prepareStep,
		searchContext,
		messageParts,
	};
}

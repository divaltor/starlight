import type { generateText, Tool, ToolSet } from "ai";
import { isSearchEnabled } from "@/services/search";
import { createSearchWebTool, SEARCH_WEB_TOOL_ID } from "@/ai/tools/search-web";

type PrepareStep = NonNullable<Parameters<typeof generateText>[0]["prepareStep"]>;

interface ToolRegistryItem {
	id: string;
	isAvailable: () => boolean;
	create: (searchContext: string[]) => Tool;
}

export function createAvailableTools() {
	const searchContext: string[] = [];
	const registry = [
		{
			id: SEARCH_WEB_TOOL_ID,
			isAvailable: isSearchEnabled,
			create: createSearchWebTool,
		},
	] satisfies ToolRegistryItem[];

	const tools = registry.reduce<ToolSet>((availableTools, item) => {
		if (item.isAvailable()) {
			availableTools[item.id] = item.create(searchContext);
		}

		return availableTools;
	}, {});

	const prepareStep: PrepareStep = ({ steps }) => {
		const searchUsed = steps.some((step) =>
			step.toolCalls.some((toolCall) => toolCall.toolName === SEARCH_WEB_TOOL_ID),
		);

		return searchUsed ? { activeTools: [] } : undefined;
	};

	return {
		tools: Object.keys(tools).length > 0 ? tools : undefined,
		prepareStep,
		searchContext,
	};
}

import type { Tool, ToolSet } from "ai";
import { isSearchEnabled } from "@/services/search";
import { createSearchWebTool, SEARCH_WEB_TOOL_ID } from "@/ai/tools/search-web";

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

	return {
		tools: Object.keys(tools).length > 0 ? tools : undefined,
		searchContext,
	};
}

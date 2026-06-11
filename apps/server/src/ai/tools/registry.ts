import type { generateText, ToolSet } from "ai";
import { createWebLookupTool, WEB_LOOKUP_TOOL_ID } from "@/ai/tools/web-lookup";
import { isSearchEnabled } from "@/services/search";
import type { ToolResultPart } from "@/types";

type PrepareStep = NonNullable<Parameters<typeof generateText>[0]["prepareStep"]>;

export function createAvailableTools() {
	const messageParts: ToolResultPart[] = [];

	const tools: ToolSet = {
		[WEB_LOOKUP_TOOL_ID]: createWebLookupTool(messageParts, {
			searchEnabled: isSearchEnabled(),
		}),
	};

	// Each web tool may be used at most once per run: once it has been called,
	// drop it so the model answers instead of padding extra tool steps.
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
		messageParts,
	};
}

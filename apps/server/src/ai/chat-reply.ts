import { Output, generateText, isStepCount, type ModelMessage, type ToolSet } from "ai";
import { Effect } from "effect";
import * as Llm from "@/ai/llm";
import { chatResponseSchema, type ChatResponse } from "@/ai/schema";
import { createWebLookupTool, WEB_LOOKUP_TOOL_ID } from "@/ai/tools/web-lookup";
import type { ToolResultPart } from "@/types";

export interface GenerateInput {
	readonly instructions: string;
	readonly messages: ModelMessage[];
	readonly trace: Omit<Llm.TraceContext, "operation">;
}

export interface GenerateResult {
	readonly output: ChatResponse | null;
	readonly messageParts: ToolResultPart[];
}

export const generate = Effect.fn("ChatReply.generate")(function* (
	input: GenerateInput,
): Effect.fn.Return<GenerateResult, Llm.Error> {
	const messageParts: ToolResultPart[] = [];
	const tools: ToolSet = {
		[WEB_LOOKUP_TOOL_ID]: createWebLookupTool(messageParts),
	};

	const output = yield* Llm.invoke(
		{ ...input.trace, operation: "message-reply" },
		async (model, generationOptions) => {
			const result = await generateText({
				model,
				...generationOptions,
				output: Output.object({ schema: chatResponseSchema }),
				instructions: input.instructions,
				messages: input.messages,
				tools,
				stopWhen: isStepCount(2),
				prepareStep: ({ steps }) => {
					const webLookupUsed = steps.some((step) =>
						step.toolCalls.some((toolCall) => toolCall.toolName === WEB_LOOKUP_TOOL_ID),
					);

					return webLookupUsed ? { activeTools: [] } : undefined;
				},
			});

			return result.output;
		},
	);

	return { output, messageParts };
});

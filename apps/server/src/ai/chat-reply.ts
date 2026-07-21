import env from "@starlight/utils/config";
import { Output, generateText, isStepCount, type ModelMessage, type ToolSet } from "ai";
import { Effect } from "effect";
import * as Llm from "@/ai/llm";
import { chatResponseSchema, type ChatResponse } from "@/ai/schema";
import { createWebLookupTool, WEB_LOOKUP_TOOL_ID } from "@/ai/tools/web";
import type { ToolResultPart } from "@/types";

const MAX_WEB_LOOKUPS = 5;

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
	const tools: ToolSet = env.EXA_API_KEY
		? { [WEB_LOOKUP_TOOL_ID]: createWebLookupTool(messageParts) }
		: {};

	const output = yield* Llm.invoke(
		{ ...input.trace, operation: "message-reply" },
		async (model, generationOptions) => {
			const result = await generateText({
				model,
				...generationOptions,
				reasoning: "minimal",
				output: Output.object({ schema: chatResponseSchema }),
				instructions: input.instructions,
				messages: input.messages,
				tools,
				stopWhen: isStepCount(MAX_WEB_LOOKUPS + 1),
				prepareStep: ({ steps }) => {
					const lookupCount = steps.reduce(
						(count, step) =>
							count +
							step.toolCalls.filter((toolCall) => toolCall.toolName === WEB_LOOKUP_TOOL_ID).length,
						0,
					);

					return lookupCount >= MAX_WEB_LOOKUPS ? { activeTools: [] } : undefined;
				},
			});

			return result.output;
		},
	);

	return { output, messageParts };
});

import { Output, generateText, isStepCount, type ModelMessage } from "ai";
import { Effect } from "effect";
import * as Llm from "@/ai/llm";
import { chatResponseSchema, type ChatResponse } from "@/ai/schema";
import { createOpenRouterWebTools } from "@/ai/tools/web";
import { OpenRouterWebToolResultPart, type ToolResultPart } from "@/types";
import { openrouter } from "@/utils/message";

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

	const output = yield* Llm.invoke(
		{ ...input.trace, operation: "message-reply" },
		async (model, generationOptions) => {
			const result = await generateText({
				model,
				...generationOptions,
				output: Output.object({ schema: chatResponseSchema }),
				instructions: input.instructions,
				messages: input.messages,
				tools: createOpenRouterWebTools(openrouter!),
				stopWhen: isStepCount(2),
			});

			const sources = result.sources
				.filter((source) => source.sourceType === "url")
				.map((source) => {
					const content = source.providerMetadata?.openrouter?.content;

					return {
						url: source.url,
						title: source.title,
						content: typeof content === "string" && content ? content : undefined,
					};
				})
				.filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index);

			if (sources.length > 0) {
				messageParts.push(
					new OpenRouterWebToolResultPart({
						type: "tool",
						toolName: "openrouter_web",
						output: { sources },
					}),
				);
			}

			return result.output;
		},
	);

	return { output, messageParts };
});

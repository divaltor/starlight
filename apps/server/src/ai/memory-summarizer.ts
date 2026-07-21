import { generateText } from "ai";
import { Effect, Schema } from "effect";
import * as Llm from "@/ai/llm";

const MAX_SUMMARY_TOKENS = 8192;

export interface SummarizeInput {
	readonly instructions: string;
	readonly prompt: string;
	readonly trace: Omit<Llm.TraceContext, "operation">;
}

export class EmptyOutputError extends Schema.TaggedErrorClass<EmptyOutputError>()(
	"MemorySummaryEmptyOutputError",
	{
		message: Schema.String,
	},
) {}

export const summarize = Effect.fn("MemorySummarizer.summarize")(function* (
	input: SummarizeInput,
): Effect.fn.Return<string, EmptyOutputError | Llm.Error> {
	const text = yield* Llm.invoke(
		{ ...input.trace, operation: "chat-memory" },
		async (model, generationOptions) => {
			const result = await generateText({
				model,
				...generationOptions,
				reasoning: "low",
				maxOutputTokens: MAX_SUMMARY_TOKENS,
				instructions: input.instructions,
				messages: [{ role: "user", content: input.prompt }],
			});

			return result.text;
		},
	);

	if (!text) {
		return yield* new EmptyOutputError({
			message: "Memory summarization returned empty output",
		});
	}

	return text;
});

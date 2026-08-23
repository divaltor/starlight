import { Effect } from "effect";
import { z } from "zod";
import * as Model from "@/ai/model";
import { createWebLookupTool } from "@/ai/tools/web";
import * as Exa from "@/services/exa";

const SYSTEM_PROMPT = await Bun.file(new URL("system-prompt.txt", import.meta.url)).text();
const MAX_REPLY_OUTPUT_TOKENS = 1024;

const reactionEmojiSchema = z.enum([
	"😁",
	"🤮",
	"🤡",
	"🤔",
	"😭",
	"🥰",
	"😡",
	"🔥",
	"👏",
	"👌",
	"👎",
	"👍",
	"💔",
	"💯",
]);

export const responseSchema = z.object({
	replies: z
		.array(
			z.discriminatedUnion("type", [
				z.object({ type: z.literal("ignore") }),
				z.object({
					replyTo: z.number().int().nullable().optional(),
					text: z.string().min(1),
					type: z.literal("text"),
				}),
				z.object({
					emoji: reactionEmojiSchema,
					messageId: z.number().int(),
					type: z.literal("reaction"),
				}),
			]),
		)
		.min(1)
		.max(3),
});

export type Response = z.infer<typeof responseSchema>;

export interface GenerateInput {
	readonly allowedUrls: readonly string[];
	readonly messages: readonly Model.Message[];
	readonly sessionId: string;
}

export type GenerateResult = Model.GenerationResult<Response>;

export const generate = Effect.fn("ChatReply.generate")(function* generate(input: GenerateInput) {
	const model = yield* Model.Service;
	const exa = yield* Exa.Service;
	const tools = exa.isEnabled() ? [createWebLookupTool(exa, new Set(input.allowedUrls))] : [];

	return yield* model.generate({
		instructions: SYSTEM_PROMPT,
		maxOutputTokens: MAX_REPLY_OUTPUT_TOKENS,
		maxToolCalls: tools.length > 0 ? 1 : 0,
		messages: input.messages,
		outputSchema: responseSchema,
		sessionId: input.sessionId,
		tools,
	});
});

import { Effect } from "effect";
import { z } from "zod";
import * as Model from "@/ai/model";
import { createWebLookupTool } from "@/ai/tools/web";
import * as Exa from "@/services/exa";

export const systemPrompt = await Bun.file(new URL("system-prompt.txt", import.meta.url)).text();
export const outputSchemaVersion = "chat-reply-v1";
export const toolsetVersion = "web-lookup-v1";
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

export const actionSchema = z.discriminatedUnion("type", [
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
]);

export const responseSchema = z.object({
  replies: z.array(actionSchema).min(1).max(3),
});

export type Response = z.infer<typeof responseSchema>;

export interface GenerateInput {
  readonly allowedUrls: readonly string[];
  readonly cacheBase?: string;
  readonly instructions?: string;
  readonly messages: readonly Model.Message[];
  readonly promptCacheKey?: string;
  readonly sessionId: string;
  readonly webLookupEnabled?: boolean;
}

export type GenerateResult = Model.GenerationResult<Response>;

export const generate = Effect.fn("ChatReply.generate")(function* generate(input: GenerateInput) {
  const model = yield* Model.Service;
  const exa = yield* Exa.Service;
  const tools =
    exa.isEnabled() && input.webLookupEnabled !== false ? [createWebLookupTool(exa, new Set(input.allowedUrls))] : [];

  return yield* model.generate({
    cacheBase: input.cacheBase,
    instructions: input.instructions ?? systemPrompt,
    maxOutputTokens: MAX_REPLY_OUTPUT_TOKENS,
    maxToolCalls: tools.length > 0 ? 1 : 0,
    messages: input.messages,
    outputSchema: responseSchema,
    promptCacheKey: input.promptCacheKey,
    sessionId: input.sessionId,
    tools,
  });
});

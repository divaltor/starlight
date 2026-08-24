import { Effect } from "effect";
import { z } from "zod";
import { Model } from "@/ai/model";
import { TelegramDelivery } from "@/conversation/delivery";
import { Exa } from "@/services/exa";

// The prompt file is read eagerly at module load; top-level await must stay at module
// scope because namespace bodies cannot contain await.
const systemPromptText = await Bun.file(new URL("system-prompt.txt", import.meta.url)).text();

export namespace ChatReply {
  export const systemPrompt = systemPromptText;
  export const outputSchemaVersion = "chat-reply-v1";
  export const toolsetVersion = "exa-mcp-v1";
  const MAX_REPLY_OUTPUT_TOKENS = 1024;

  const reactionEmojiSchema = z.enum(TelegramDelivery.reactionEmojis);

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
    const tools = exa.isEnabled() && input.webLookupEnabled !== false ? exa.tools : {};

    return yield* model.generate({
      cacheBase: input.cacheBase,
      instructions: input.instructions ?? systemPrompt,
      maxOutputTokens: MAX_REPLY_OUTPUT_TOKENS,
      maxToolCalls: Object.keys(tools).length > 0 ? 1 : 0,
      messages: input.messages,
      outputSchema: responseSchema,
      promptCacheKey: input.promptCacheKey,
      sessionId: input.sessionId,
      tools,
    });
  });
}

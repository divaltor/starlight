import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import type { ChatTools } from "@/ai/chat-tools";
import { Model } from "@/ai/model";
import { TelegramDelivery } from "@/conversation/delivery";

// The prompt file is read eagerly at module load; top-level await must stay at module
// scope because namespace bodies cannot contain await.
const systemPromptText = await Bun.file(new URL("system-prompt.txt", import.meta.url)).text();

export namespace ChatReply {
  export const systemPrompt = systemPromptText;
  export const outputSchemaVersion = "chat-reply-v1";
  export const maxOutputTokens = 4096;
  const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
  const MAX_AGENT_TOOL_STEPS = 3;

  const reactionEmojiSchema = z.enum(TelegramDelivery.reactionEmojis);

  export const actionSchema = z.union([
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
    readonly cachePrefixMessageCount?: number;
    readonly instructions?: string;
    readonly messages: readonly Model.Message[];
    readonly promptCacheKey?: string;
    readonly sessionId: string;
    readonly toolset: ChatTools.Resolved;
  }

  export type GenerateResult = Model.GenerationResult<Response>;

  export interface Interface {
    readonly generate: (input: GenerateInput) => Effect.Effect<GenerateResult, Model.Error>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/ChatReply") {}

  export const layer: Layer.Layer<Service, never, Model.Service> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const model = yield* Model.Service;
      return Service.of({
        generate: Effect.fn("ChatReply.generate")(function* generate(input) {
          return yield* model.generate({
            cacheBase: input.cacheBase,
            cachePrefixMessageCount: input.cachePrefixMessageCount,
            instructions: input.instructions ?? systemPrompt,
            maxOutputTokens,
            maxToolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
            maxToolSteps: Object.keys(input.toolset.tools).length > 0 ? MAX_AGENT_TOOL_STEPS : 0,
            messages: input.messages,
            outputSchema: responseSchema,
            promptCacheKey: input.promptCacheKey,
            sessionId: input.sessionId,
            tools: input.toolset.tools,
          });
        }),
      });
    }),
  );
}

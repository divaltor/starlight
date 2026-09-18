import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import type { ChatTools } from "@/ai/chat-tools";
import { ChatReply } from "@/ai/chat-reply";
import guestPromptText from "@/ai/guest-prompt.txt";
import { Model } from "@/ai/model";
import personaPromptText from "@/ai/persona-prompt.txt";
import type { Media } from "@/media/media";

export namespace GuestReply {
  const MAX_OUTPUT_TOKENS = 2048;
  const paragraphs = z
    .array(z.string().trim().min(1).max(1200))
    .min(1)
    .max(3)
    .describe("Ordered plain-text paragraphs for one Telegram guest response");
  const outputSchema = z.object({
    type: z.enum(["answer", "clarification"]),
    paragraphs,
    followUp: z
      .object({
        purpose: z.literal("decision_support"),
        text: z.string().trim().min(1).max(240),
      })
      .nullable()
      .describe("Usually null; one exceptional question that materially helps with a decision"),
  });

  export interface Interface {
    readonly generate: (input: {
      readonly message: string;
      readonly repliedMedia: readonly Media.Loaded[];
      readonly repliedMessage: string | null;
      readonly sessionId: string;
      readonly toolset: ChatTools.Resolved;
    }) => Effect.Effect<string, Model.Error>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/GuestReply") {}

  export const layer: Layer.Layer<Service, never, Model.Service> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const model = yield* Model.Service;

      return Service.of({
        generate: Effect.fn("GuestReply.generate")(function* generate(input) {
          const generated = yield* model.generate({
            instructions: `${personaPromptText}\n\n${guestPromptText}`,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            maxToolOutputBytes: ChatReply.maxToolOutputBytes,
            maxToolCalls: Object.keys(input.toolset.tools).length > 0 ? ChatReply.maxToolCalls : 0,
            messages: [
              {
                role: "user",
                media: input.repliedMedia,
                text: `Replied-to message:\n${input.repliedMessage ?? "[none]"}\nReplied-to attachments: ${input.repliedMedia.length}\n\nCurrent guest message:\n${input.message}`,
              },
            ],
            outputSchema,
            sessionId: input.sessionId,
            telemetryFunctionId: "guest-reply",
            tools: input.toolset.tools,
          });
          if (generated.output.type === "clarification") {
            return generated.output.paragraphs[0]!;
          }
          return generated.output.paragraphs
            .map((paragraph, index) =>
              generated.output.followUp !== null && index === generated.output.paragraphs.length - 1
                ? `${paragraph} ${generated.output.followUp.text}`
                : paragraph,
            )
            .join("\n\n");
        }),
      });
    }),
  );
}

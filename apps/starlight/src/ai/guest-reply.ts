import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import guestPromptText from "@/ai/guest-prompt.txt";
import { Model } from "@/ai/model";
import personaPromptText from "@/ai/persona-prompt.txt";
import type { Media } from "@/media/media";

export namespace GuestReply {
  const MAX_OUTPUT_TOKENS = 2048;
  const outputSchema = z.object({
    text: z.string().min(1).max(4096).describe("Plain-text Telegram response to the guest message"),
  });

  export interface Interface {
    readonly generate: (input: {
      readonly message: string;
      readonly repliedMedia: readonly Media.Loaded[];
      readonly repliedMessage: string | null;
      readonly sessionId: string;
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
            maxToolOutputBytes: 0,
            maxToolSteps: 0,
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
            tools: {},
          });
          return generated.output.text;
        }),
      });
    }),
  );
}

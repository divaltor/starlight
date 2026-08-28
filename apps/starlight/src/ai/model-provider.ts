import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { Context, Layer } from "effect";
import { selected } from "@/ai/model-profile";

export namespace ModelProvider {
  export interface Interface {
    readonly model: LanguageModel;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/ModelProvider") {}

  export function defaultLayer(apiKey: string): Layer.Layer<Service> {
    return Layer.succeed(Service)(
      Service.of({
        model: createOpenRouter({
          apiKey,
          appName: "Starlight",
          compatibility: "strict",
        }).chat(selected.model, {
          provider: {
            allow_fallbacks: selected.route.allowFallbacks,
            data_collection: "deny",
            only: [...selected.route.only],
            order: [...selected.route.only],
            require_parameters: selected.route.requireParameters,
          },
          reasoning: selected.reasoning,
          usage: { include: true },
        }),
      }),
    );
  }
}

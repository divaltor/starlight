import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { Context, Layer } from "effect";
import { ModelProfile } from "@/ai/model-profile";

export namespace ModelProvider {
  export interface Interface {
    readonly model: LanguageModel;
    readonly profile: ModelProfile.Profile;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/ModelProvider") {}

  export function defaultLayer(
    apiKey: string,
    profile: ModelProfile.Profile = ModelProfile.selected,
  ): Layer.Layer<Service> {
    return Layer.succeed(Service)(
      Service.of({
        model: createOpenRouter({
          apiKey,
          appName: "Starlight",
          compatibility: "strict",
        }).chat(profile.model, {
          provider: {
            allow_fallbacks: profile.route.allowFallbacks,
            data_collection: "deny",
            only: [...profile.route.only],
            order: [...profile.route.only],
            require_parameters: profile.route.requireParameters,
          },
          reasoning: profile.reasoning,
          usage: { include: true },
        }),
        profile,
      }),
    );
  }
}

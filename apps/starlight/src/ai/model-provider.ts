import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { selected } from "@/ai/model-profile";

export interface Interface {
  readonly model: Option.Option<LanguageModel>;
}

export class Service extends Context.Service<Service, Interface>()("starlight/ModelProvider") {}

export const defaultLayer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* layer() {
    const apiKey = yield* Config.option(Config.redacted("OPENROUTER_API_KEY")).pipe(
      // A malformed env resolves to "no model" instead of failing startup; generate
      // surfaces the Unavailable error through the normal reply path.
      Effect.catchTag("ConfigError", () => Effect.succeed(Option.none<Redacted.Redacted>())),
    );

    return Service.of({
      model: apiKey.pipe(
        Option.flatMap((value) => {
          const key = Redacted.value(value).trim();
          if (!key) return Option.none();

          return Option.some(
            createOpenRouter({
              apiKey: key,
              appName: "Starlight",
              compatibility: "strict",
            }).chat(selected.model, {
              provider: {
                allow_fallbacks: selected.route.allowFallbacks,
                only: [...selected.route.only],
                order: [...selected.route.only],
                require_parameters: selected.route.requireParameters,
              },
              reasoning: selected.reasoning,
              usage: { include: true },
            }),
          );
        }),
      ),
    });
  }),
);

export function testLayer(model: LanguageModel): Layer.Layer<Service> {
  return Layer.succeed(Service)(Service.of({ model: Option.some(model) }));
}

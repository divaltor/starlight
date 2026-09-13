import type { ToolSet } from "ai";
import { Context, Effect, Layer, Schema } from "effect";
import { Exa } from "@/ai/tools/exa";

export namespace ChatTools {
  export type Profile = readonly string[];

  export interface Resolved {
    readonly profile: Profile;
    readonly tools: ToolSet;
  }

  export class ProfileUnavailable extends Schema.TaggedError<ProfileUnavailable>()("ProfileUnavailable", {
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export interface Interface {
    readonly availableProfile: Profile;
    readonly resolve: (profile: Profile) => Effect.Effect<Resolved, ProfileUnavailable>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/ChatTools") {}

  export const layer: Layer.Layer<Service, never, Exa.Service> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const exa = yield* Exa.Service;
      const sources = [{ id: Exa.profileId, tools: exa.tools }];
      const ids = sources.map((source) => source.id);
      if (new Set(ids).size !== ids.length) {
        return yield* Effect.die(new Error("Chat tool source profile IDs must be unique"));
      }
      const names = sources.flatMap((source) => Object.keys(source.tools));
      if (new Set(names).size !== names.length) {
        return yield* Effect.die(new Error("Chat tool names must be unique"));
      }
      const byId = new Map(sources.map((source) => [source.id, source]));
      const availableProfile = ids.toSorted();

      return Service.of({
        availableProfile,
        resolve: Effect.fn("ChatTools.resolve")(function* resolve(profile) {
          const requested = [...new Set(profile)].toSorted();
          if (requested.length !== profile.length || requested.some((id, index) => id !== profile[index])) {
            return yield* new ProfileUnavailable({ message: "Chat tool profile is invalid", retryable: false });
          }
          const selected = requested.map((id) => byId.get(id));
          if (selected.some((source) => source === undefined)) {
            return yield* new ProfileUnavailable({ message: "Chat tool profile is unavailable", retryable: true });
          }
          const available = selected.filter((source): source is (typeof sources)[number] => source !== undefined);
          return {
            profile: requested,
            tools: Object.fromEntries(available.flatMap((source) => Object.entries(source.tools))),
          };
        }),
      });
    }),
  );
}

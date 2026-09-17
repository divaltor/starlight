import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { ChatTools } from "@/ai/chat-tools";
import { Exa } from "@/ai/tools/exa";
import { Twitter } from "@/ai/tools/twitter";
import { Youtube } from "@/ai/tools/youtube";

const layer = ChatTools.layer.pipe(
  Layer.provide(
    Layer.succeed(Twitter.Service)({ tools: { read_twitter: { inputSchema: z.object({ url: z.url() }) } } }),
  ),
  Layer.provide(
    Layer.succeed(Youtube.Service)({ tools: { read_youtube: { inputSchema: z.object({ url: z.url() }) } } }),
  ),
  Layer.provide(
    Layer.succeed(Exa.Service)({
      tools: {
        web_search_exa: {
          execute: () => Promise.resolve({ result: "fixture" }),
          inputSchema: z.object({ query: z.string() }),
        },
      },
    }),
  ),
);

test("resolves the exact persisted tool profile", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const tools = yield* ChatTools.Service;
      return {
        availableProfile: tools.availableProfile,
        all: yield* tools.resolve(tools.availableProfile),
        current: yield* tools.resolve([Exa.profileId]),
        previous: yield* tools.resolve([]),
      };
    }).pipe(Effect.provide(layer)),
  );

  expect(result.availableProfile).toEqual([Exa.profileId, Twitter.profileId, Youtube.profileId]);
  expect(Object.keys(result.all.tools)).toEqual(["web_search_exa", "read_twitter", "read_youtube"]);
  expect(Object.keys(result.current.tools)).toEqual(["web_search_exa"]);
  expect(result.previous.tools).toEqual({});
});

test("rejects a persisted profile whose provider is unavailable", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const tools = yield* ChatTools.Service;
      return yield* tools.resolve(["calendar-v1"]);
    }).pipe(Effect.flip, Effect.provide(layer)),
  );

  expect(error._tag).toBe("ProfileUnavailable");
  expect(error.retryable).toBe(true);
});

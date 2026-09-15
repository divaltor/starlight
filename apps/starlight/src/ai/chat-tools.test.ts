import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { ChatTools } from "@/ai/chat-tools";
import { Exa } from "@/ai/tools/exa";
import { TelegramModeration } from "@/ai/tools/telegram-moderation";
import { Twitter } from "@/ai/tools/twitter";

const execution = { chatId: -100, liveMessageSenders: new Map<number, number | null>() };
const layer = ChatTools.layer.pipe(
  Layer.provide(
    Layer.succeed(TelegramModeration.Service)({
      tools: () => ({
        mute_telegram_user: {
          inputSchema: z.object({
            durationMinutes: z.number(),
            requestMessageId: z.number(),
            targetUserId: z.number(),
          }),
        },
      }),
    }),
  ),
  Layer.provide(
    Layer.succeed(Twitter.Service)({ tools: { read_twitter: { inputSchema: z.object({ url: z.url() }) } } }),
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
        all: yield* tools.resolve({ execution, profile: tools.availableProfile }),
        current: yield* tools.resolve({ execution, profile: [Exa.profileId] }),
        previous: yield* tools.resolve({ execution, profile: [] }),
      };
    }).pipe(Effect.provide(layer)),
  );

  expect(result.availableProfile).toEqual([Exa.profileId, TelegramModeration.profileId, Twitter.profileId]);
  expect(Object.keys(result.all.tools)).toEqual(["web_search_exa", "mute_telegram_user", "read_twitter"]);
  expect(Object.keys(result.current.tools)).toEqual(["web_search_exa"]);
  expect(result.previous.tools).toEqual({});
});

test("rejects a persisted profile whose provider is unavailable", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const tools = yield* ChatTools.Service;
      return yield* tools.resolve({ execution, profile: ["calendar-v1"] });
    }).pipe(Effect.flip, Effect.provide(layer)),
  );

  expect(error._tag).toBe("ProfileUnavailable");
  expect(error.retryable).toBe(true);
});

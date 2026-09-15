import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { ChatMember } from "grammy/types";
import { TelegramModeration } from "@/ai/tools/telegram-moderation";
import { Database } from "@/services/database";

const requesterId = 9_001_001;
const targetUserId = 9_001_002;
const api = {
  getChatMember: (_chatId: number | string, userId: number) =>
    Promise.resolve(
      userId === requesterId
        ? ({
            is_anonymous: false,
            status: "creator",
            user: { first_name: `User ${userId}`, id: userId, is_bot: false },
          } satisfies ChatMember)
        : ({
            status: "member",
            user: { first_name: `User ${userId}`, id: userId, is_bot: false },
          } satisfies ChatMember),
    ),
  restrictChatMember: () => Promise.resolve(true as const),
};
const database = Database.layer("postgresql://prisma:prisma@localhost:5432/prisma");
const layer = Layer.mergeAll(database, TelegramModeration.layer(api).pipe(Layer.provide(database)));

test("allows one concurrent moderation quip per target user in 72 hours", async () => {
  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const databaseService = yield* Database.Service;
      const moderation = yield* TelegramModeration.Service;
      yield* databaseService.query((client) => client.user.deleteMany({ where: { telegramId: BigInt(targetUserId) } }));
      const mute = moderation.tools({
        chatId: -100_001,
        liveMessageSenders: new Map([[51, requesterId]]),
      }).mute_telegram_user;
      const options = { context: null, messages: [], toolCallId: "mute" };
      const muteResults = yield* Effect.promise(() =>
        Promise.all([
          mute.execute!({ durationMinutes: 5, requestMessageId: 51, targetUserId }, options),
          mute.execute!({ durationMinutes: 10, requestMessageId: 51, targetUserId }, options),
        ]),
      );
      yield* databaseService.query((client) => client.user.deleteMany({ where: { telegramId: BigInt(targetUserId) } }));
      return muteResults;
    }).pipe(Effect.provide(layer)),
  );

  expect(results.map((result) => result.quipAllowed).toSorted()).toEqual([false, true]);
});

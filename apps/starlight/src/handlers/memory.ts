import { Composer } from "grammy";
import type { Context } from "grammy";
import { Effect } from "effect";
import { Memory } from "@/memory/memory";
import { runtime } from "@/services/runtime";

export function createMemoryHandler(whitelistedDmUserIds: readonly number[]): Composer<Context> {
  const composer = new Composer<Context>();
  const whitelist = new Set(whitelistedDmUserIds);
  const privateChat = composer.chatType("private");
  const authorized = privateChat.command("forget").filter((ctx) => whitelist.has(ctx.from.id));

  authorized
    .filter((ctx) => ctx.match.trim().length === 0)
    .use((ctx) => ctx.reply("Использование: /forget что нужно забыть"));
  authorized
    .filter((ctx) => ctx.match.trim().length > 0)
    .use(async (ctx) => {
      await runtime.runPromise(
        Effect.gen(function* forget() {
          const memory = yield* Memory.Service;
          return yield* memory.forget({
            firstName: ctx.from.first_name,
            isBot: ctx.from.is_bot,
            lastName: ctx.from.last_name ?? null,
            request: ctx.match.trim(),
            telegramId: ctx.from.id,
            username: ctx.from.username ?? null,
          });
        }),
      );
      await ctx.reply("Запрос сохранён. Эта информация не будет добавляться в будущую память.");
    });
  privateChat
    .command("forget")
    .filter((ctx) => !whitelist.has(ctx.from.id))
    .use((ctx) => ctx.reply("Личные сообщения для этого аккаунта не разрешены."));

  return composer;
}

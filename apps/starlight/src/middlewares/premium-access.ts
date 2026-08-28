import { Effect } from "effect";
import type { Context, MiddlewareFn } from "grammy";
import { Database } from "@/services/database";
import { runtime } from "@/services/runtime";

const premiumAccess: MiddlewareFn<Context> = async (ctx, next) => {
  if (!ctx.chat) return;

  // Guest chat IDs belong to an independent chat; premium access belongs to the sender's regular DM chat.
  const chatId = ctx.guestMessage ? ctx.from!.id : ctx.chat.id;

  const chat = await runtime.runPromise(
    Effect.gen(function* verifyChatAccess() {
      const database = yield* Database.Service;
      return yield* database.query((client) =>
        client.chat.findUnique({ where: { id: BigInt(chatId) }, select: { isPremium: true } }),
      );
    }),
  );

  if (chat?.isPremium) {
    await next();
    return;
  }

  if (ctx.chat.type === "private" && ctx.message) {
    await ctx.reply("Личные сообщения для этого аккаунта не разрешены.");
  }
};

export default premiumAccess;

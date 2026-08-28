import { Effect } from "effect";
import { Composer } from "grammy";
import type { Context } from "grammy";
import { Database } from "@/services/database";
import { runtime } from "@/services/runtime";

const composer = new Composer<Context>();
const privateChat = composer.chatType("private");

privateChat.command("start").use(async (ctx, next) => {
  await runtime.runPromise(
    Effect.gen(function* createChat() {
      const database = yield* Database.Service;
      yield* database.query((client) =>
        client.chat.upsert({
          where: { id: BigInt(ctx.chat.id) },
          create: { id: BigInt(ctx.chat.id), username: ctx.chat.username },
          update: {},
        }),
      );
    }),
  );

  await next();
});

export default composer;

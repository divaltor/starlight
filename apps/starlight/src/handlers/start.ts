import { Composer } from "grammy";
import type { Context } from "grammy";

export function createStartHandler(whitelistedDmUserIds: readonly number[]): Composer<Context> {
  const composer = new Composer<Context>();
  const whitelist = new Set(whitelistedDmUserIds);
  const privateChat = composer.chatType("private");

  privateChat
    .command("start")
    .filter((ctx) => whitelist.has(ctx.from.id))
    .use((ctx) =>
      ctx.reply("Привет, я <b>Старка</b> ✨\n\nЗдесь можно продолжить разговор из разрешённых чатов.", {
        parse_mode: "HTML",
      }),
    );
  privateChat
    .command("start")
    .filter((ctx) => !whitelist.has(ctx.from.id))
    .use((ctx) => ctx.reply("Личные сообщения для этого аккаунта не разрешены."));

  return composer;
}

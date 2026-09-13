import { Composer } from "grammy";
import type { Context } from "grammy";

const composer = new Composer<Context>();
const privateChat = composer.chatType("private");

privateChat.command("start").use((ctx) =>
  ctx.reply("Привет, я <b>Старка</b> ✨\n\nЗдесь можно продолжить разговор из разрешённых чатов.", {
    parse_mode: "HTML",
  }),
);

export default composer;

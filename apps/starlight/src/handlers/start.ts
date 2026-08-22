import { Composer } from "grammy";
import type { Context } from "@/types";

const composer = new Composer<Context>();
const privateChat = composer.chatType("private");

privateChat.command("start", async (ctx) => {
	await ctx.reply(
		"Привет, я <b>Старка</b> ✨\n\nДобавь меня в групповой чат, и я смогу отвечать на сообщения и иногда поддерживать разговор.",
		{ parse_mode: "HTML" },
	);
});

export default composer;

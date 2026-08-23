import { Composer } from "grammy";
import type { Context } from "grammy";

const composer = new Composer<Context>();
const privateChat = composer.chatType("private");

privateChat.command("start", async (ctx) => {
	await ctx.reply(
		"Привет, я <b>Старка</b> ✨\n\nДобавь меня в групповой чат и позови, когда захочешь поговорить.",
		{ parse_mode: "HTML" },
	);
});

export default composer;

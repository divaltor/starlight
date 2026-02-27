import { prisma } from "@starlight/utils";
import { Composer } from "grammy";
import type { Context } from "@/bot";
import { scheduleChatMemorySummaries } from "@/queue/memory";
import { isAdminOrCreator } from "@/utils/auth";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);

groupChat.command("memory").filter(isAdminOrCreator, async (ctx) => {
	const chatId = BigInt(ctx.chat.id);
	const messageThreadId = ctx.message.message_thread_id ?? null;

	const lastMessage = await prisma.message.findFirst({
		where: {
			chatId,
			...(messageThreadId !== null ? { messageThreadId } : {}),
		},
		select: { messageId: true },
		orderBy: { messageId: "desc" },
	});

	await scheduleChatMemorySummaries({
		chatId,
		// biome-ignore lint/style/noNonNullAssertion: Can't be null, middleware will add at least 1 message even if it this command
		messageId: lastMessage!.messageId,
		messageThreadId,
		forceRebuild: true,
	});

	await ctx.reply("щас снова идти за блокнотом, ни дня без отдыха");
});

groupChat.command("memory").filter(
	(ctx) => !isAdminOrCreator(ctx),
	async (ctx) => {
		await ctx.reply("а может тебе еще и борщ сварить?");
	},
);

export default composer;

import { prisma } from "@starlight/utils";
import { Composer } from "grammy";
import type { Context } from "@/bot";
import { scheduleChatMemorySummaries } from "@/queue/memory";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);

groupChat.command("memory").filter(
	async (ctx) => {
		if (!ctx.from) {
			return false;
		}

		const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
		return member.status === "administrator" || member.status === "creator";
	},
	async (ctx) => {
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

		if (!lastMessage) {
			await ctx.reply("No messages found to build memory from.");
			return;
		}

		await scheduleChatMemorySummaries({
			chatId,
			messageId: lastMessage.messageId,
			messageThreadId,
		});

		await ctx.reply("Memory build triggered.");
	}
);

groupChat.command("memory").filter(
	async (ctx) => {
		if (!ctx.from) {
			return true;
		}

		const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
		return member.status !== "administrator" && member.status !== "creator";
	},
	async (ctx) => {
		await ctx.reply("Only admins and creators can use this command.");
	}
);

export default composer;

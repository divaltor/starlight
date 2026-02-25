import { env, prisma } from "@starlight/utils";
import { Composer } from "grammy";
import type { Context } from "@/bot";
import { scheduleChatMemorySummaries } from "@/queue/memory";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);

const isAdminOrCreator = (ctx: Context) => {
	// TOOD: Search how to remove that check
	if (!ctx.from) {
		return false;
	}

	if (env.SUPERVISOR_IDS.includes(ctx.from.id)) {
		return true;
	}

	return ctx.userChatMember?.status === "administrator" || ctx.userChatMember?.status === "creator";
};

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
	});

	await ctx.reply("Memory build triggered.");
});

groupChat.command("memory").filter(
	(ctx) => !isAdminOrCreator(ctx),
	async (ctx) => {
		await ctx.reply("Only admins, creators, and supervisors can use this command.");
	},
);

export default composer;

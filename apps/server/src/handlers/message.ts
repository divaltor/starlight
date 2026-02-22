import { env, prisma } from "@starlight/utils";
import { generateText } from "ai";
import { Composer } from "grammy";
import type { Context } from "@/bot";
import { getLangfuseTelemetry } from "@/otel";
import {
	type ConversationMessage,
	formatSenderName,
	getMessageContent,
	openrouter,
	SYSTEM_PROMPT,
	shouldReplyToMessage,
	toConversationMessage,
} from "@/utils/message";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);

const isAdminOrCreator = async (ctx: Context) => {
	if (!(ctx.from && ctx.chat)) {
		return false;
	}

	const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);

	return member.status === "administrator" || member.status === "creator";
};

groupChat.command("clear", async (ctx) => {
	if (!(await isAdminOrCreator(ctx))) {
		await ctx.reply("Only admins and creators can use this command.");
		return;
	}

	const messageThreadId = ctx.message.message_thread_id ?? null;

	const { count } = await prisma.message.updateMany({
		where: {
			chatId: BigInt(ctx.chat.id),
			messageThreadId,
			deletedAt: null,
		},
		data: {
			deletedAt: new Date(),
		},
	});

	if (messageThreadId === null) {
		await ctx.reply(`Cleared ${count} messages without topic history.`);
		return;
	}

	await ctx.reply(`Cleared ${count} messages from this topic history.`);
});

groupChat.on("message").filter(
	(ctx) => shouldReplyToMessage(ctx, ctx.message),
	async (ctx) => {
		if (!openrouter) {
			ctx.logger.debug("OPENROUTER_API_KEY is not set, skipping AI reply");
			return;
		}

		const messageThreadId = ctx.message.message_thread_id ?? null;

		const history = await prisma.message.findMany({
			where: {
				chatId: BigInt(ctx.chat.id),
				messageThreadId,
				messageId: {
					not: ctx.message.message_id,
				},
				OR: [{ text: { not: null } }, { caption: { not: null } }],
			},
			select: {
				fromId: true,
				fromUsername: true,
				fromFirstName: true,
				text: true,
				caption: true,
			},
			orderBy: {
				date: "desc",
			},
			take: env.HISTORY_LIMIT,
		});

		const botId = BigInt(ctx.me.id);
		const messages: ConversationMessage[] = history
			.reverse()
			.map((entry) => toConversationMessage(entry, botId))
			.filter((entry): entry is ConversationMessage => entry !== null);

		const currentMessageContent = getMessageContent(ctx.message);
		if (!currentMessageContent) {
			return;
		}

		messages.push({
			role: "user",
			content: `${formatSenderName({
				fromUsername: ctx.message.from?.username ?? null,
				fromFirstName: ctx.message.from?.first_name ?? null,
				fromId: ctx.message.from ? BigInt(ctx.message.from.id) : null,
			})}: ${currentMessageContent}`,
		});

		const { text } = await generateText({
			model: openrouter(env.OPENROUTER_MODEL),
			system: SYSTEM_PROMPT,
			messages,
			experimental_telemetry: getLangfuseTelemetry(ctx),
		});

		const reply = text.trim();
		if (!reply) {
			return;
		}

		await ctx.api.sendMessage(ctx.chat.id, reply, {
			reply_to_message_id: ctx.message.message_id,
			message_thread_id: ctx.message.message_thread_id,
		});
	}
);

export default composer;

import { env, prisma } from "@starlight/utils";
import { generateText } from "ai";
import { Composer } from "grammy";
import type { Context } from "@/bot";
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

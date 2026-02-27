import { env, prisma } from "@starlight/utils";
import { Output, generateText } from "ai";
import { Composer } from "grammy";
import { chatResponseSchema } from "@/ai/schema";
import type { Context } from "@/bot";
import { saveMessage } from "@/middlewares/message";
import { getLangfuseTelemetry } from "@/otel";
import { buildChatMemoryPromptContext } from "@/services/chat-memory";
import { History } from "@/utils/history";
import {
	SYSTEM_PROMPT,
	openrouter,
	shouldReplyToMessage,
	stripBotAnnotations,
	toConversationMessage,
} from "@/utils/message";
import { sleep } from "@/utils/tools";
import { isAdminOrCreator } from "@/utils/auth";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);

const RESPONSE_DELAY_MS = 500;

groupChat.command("clear").filter(
	(ctx) => !isAdminOrCreator(ctx),
	async (ctx) => {
		await ctx.reply("Only admins, creators, and supervisors can use this command.");
	},
);

groupChat.command("clear").filter(isAdminOrCreator, async (ctx) => {
	const messageThreadId = ctx.message.message_thread_id ?? null;

	await prisma.message.updateMany({
		where: {
			chatId: BigInt(ctx.chat.id),
			messageThreadId,
			deletedAt: null,
		},
		data: {
			deletedAt: new Date(),
		},
	});

	await ctx.reply(`Ты чево наделал...`);
});

groupChat.on("message").filter(
	(ctx) => {
		if (!openrouter) {
			ctx.logger.debug("OPENROUTER_API_KEY is not set, skipping AI reply");
			return false;
		}

		return true;
	},
	async (ctx) => {
		await sleep(RESPONSE_DELAY_MS, { minMs: 100, maxMs: 800 });

		// TODO: Revisit logic with waiting for new messages and should reply or not because now it tend to ignore even if it's direct mention because new messages appear
		if (
			await prisma.message.hasNewerMessages({
				chatId: ctx.chat.id,
				messageId: ctx.message.message_id,
				messageThreadId: ctx.message.message_thread_id,
			})
		) {
			ctx.logger.debug(
				{
					chatId: ctx.chat.id,
					messageId: ctx.message.message_id,
					thread_id: ctx.message.message_thread_id,
				},
				"Skipping stale AI reply after response delay",
			);
			return false;
		}

		return true;
	},
	(ctx) => shouldReplyToMessage(ctx, ctx.message),
	async (ctx) => {
		const triggerMessageId = ctx.message.message_id;
		const messageThreadId = ctx.message.message_thread_id ?? null;
		const chatId = BigInt(ctx.chat.id);
		const botId = ctx.me.id;

		await ctx.replyWithChatAction("typing");

		const { messages, directReplyEntry, directReplySupplementalContent, knownMessageIds } =
			await History.build(ctx);

		const currentConversationMessage = toConversationMessage(
			{
				messageId: triggerMessageId,
				fromId: ctx.message.from?.id ?? null,
				fromUsername: ctx.message.from?.username ?? null,
				fromFirstName: ctx.message.from?.first_name ?? null,
				text: ctx.message.text ?? null,
				caption: ctx.message.caption ?? null,
				attachments: ctx.attachments,
			},
			botId,
			{
				supplementalContent:
					directReplySupplementalContent.length > 0 && !directReplyEntry
						? directReplySupplementalContent
						: undefined,
			},
		);

		// TODO: Refactor to remove that, we're guaranteed to get not-empty message due handler filtering
		if (!currentConversationMessage) {
			return;
		}

		const memoryContext = await buildChatMemoryPromptContext({
			chatId,
			chatSettings: ctx.chatSettings,
			messageThreadId,
		});

		const allMessages = [
			...(memoryContext
				? [
						{
							role: "assistant" as const,
							content: memoryContext,
						},
					]
				: []),
			...messages,
			currentConversationMessage,
		];

		knownMessageIds.add(triggerMessageId);

		const { output } = await generateText({
			model: openrouter!(env.OPENROUTER_MODEL),
			output: Output.object({ schema: chatResponseSchema }),
			system: SYSTEM_PROMPT,
			messages: allMessages,
			experimental_telemetry: getLangfuseTelemetry("message-reply", {
				chatId: String(ctx.chat.id),
				messageId: String(triggerMessageId),
				messageThreadId: String(messageThreadId ?? "main"),
				userId: ctx.message.from?.id ? String(ctx.message.from.id) : "unknown",
				sessionId: `${ctx.chat.id}:${messageThreadId ?? "main"}`,
			}),
			temperature: 0.75,
			topK: 80,
		});

		if (!output) {
			return;
		}

		for (const reply of output.replies) {
			const replyText = stripBotAnnotations(reply.text);

			if (!replyText) {
				continue;
			}

			const replyToId =
				reply.reply_to !== null && knownMessageIds.has(reply.reply_to)
					? reply.reply_to
					: triggerMessageId;

			const sentMessage = await ctx.api.sendMessage(ctx.chat.id, replyText, {
				reply_to_message_id: replyToId,
				message_thread_id: ctx.message.message_thread_id,
			});

			await saveMessage({ ctx, msg: sentMessage });
		}
	},
);

export default composer;

import { env, prisma } from "@starlight/utils";
import { Output, generateText, stepCountIs } from "ai";
import { Composer, GrammyError } from "grammy";
import { chatResponseSchema } from "@/ai/schema";
import { createAvailableTools } from "@/ai/tools/registry";
import { bot, type Context } from "@/bot";
import { saveMessage } from "@/middlewares/message";
import { getLangfuseTelemetry } from "@/otel";
import { buildChatMemoryPromptContext } from "@/services/chat-memory";
import { History } from "@/utils/history";
import {
	getSystemPrompt,
	openrouter,
	shouldReplyToMessage,
	stripBotAnnotations,
	toConversationTurn,
	toModelMessage,
} from "@/utils/message";
import { sleep } from "@/utils/tools";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);
const whitelistedGroupChat = groupChat.filter((ctx) =>
	env.WHITELIST_CHAT_IDS.includes(ctx.chat.id),
);

const RESPONSE_DELAY_MS = 500;

const Q_COMMAND_REGEX = /^\/q(@\w+)?(\s|$)/i;

whitelistedGroupChat
	.on("message")
	.filter((ctx) => {
		if (!openrouter) {
			ctx.logger.debug("OPENROUTER_API_KEY is not set, skipping AI reply");
			return false;
		}

		return true;
	})
	.filter((ctx) => {
		const text = ctx.message.text ?? ctx.message.caption;

		if (text && Q_COMMAND_REGEX.test(text)) {
			ctx.logger.debug("Skipping AI reply for /q command");
			return false;
		}

		return true;
	})
	.filter(async (ctx) => {
		await sleep(RESPONSE_DELAY_MS, { minMs: 1000, maxMs: 3500 });

		// TODO: Revisit logic with waiting for new messages and should reply or not because now it tend to ignore even if it's direct mention because new messages appear
		if (
			await prisma.message.hasNewerMessages({
				chatId: ctx.chat.id,
				messageId: ctx.message.message_id,
				messageThreadId: ctx.message.message_thread_id ?? null,
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
	})
	.filter((ctx) => shouldReplyToMessage(ctx, ctx.message))
	.use(async (ctx) => {
		const triggerMessageId = ctx.message.message_id;
		const messageThreadId = ctx.message.message_thread_id ?? null;
		const chatId = BigInt(ctx.chat.id);
		const botId = ctx.me.id;

		ctx.logger.debug(
			{ chatId: ctx.chat.id, messageId: triggerMessageId },
			`Processing for AI (thread: ${messageThreadId}, text: ${!!ctx.message.text}, caption: ${!!ctx.message.caption}, attachments: ${ctx.attachments.length})`,
		);

		await ctx.replyWithChatAction("typing");

		const {
			messages,
			directReplyEntry,
			directReplySupplementalAttachments,
			directReplySupplementalContent,
			knownMessageIds,
		} = await History.build(ctx);

		ctx.logger.debug(
			`Built conversation: ${messages.length} messages, directReply: ${!!directReplyEntry}, supplemental: ${directReplySupplementalContent.length}`,
		);

		const currentConversationTurn = toConversationTurn(
			{
				messageId: triggerMessageId,
				replyToMessageId: ctx.message.reply_to_message?.message_id,
				messageThreadId: ctx.message.message_thread_id,
				fromId: ctx.message.from?.id,
				fromUsername: ctx.message.from?.username,
				fromFirstName: ctx.message.from?.first_name,
				text: ctx.message.text,
				caption: ctx.message.caption,
				attachments: ctx.attachments,
			},
			botId,
			{
				includeAttachmentData: true,
				supplementalAttachments:
					directReplySupplementalAttachments.length > 0 && !directReplyEntry
						? directReplySupplementalAttachments
						: undefined,
				supplementalContent:
					directReplySupplementalContent.length > 0 && !directReplyEntry
						? directReplySupplementalContent
						: undefined,
			},
		);

		const memoryContext = await buildChatMemoryPromptContext({
			chatId,
			messageThreadId,
		});

		const allMessages = [
			...messages.map((message) => toModelMessage(message)),
			toModelMessage(currentConversationTurn),
		];
		const system = [getSystemPrompt(), memoryContext].filter(Boolean).join("\n\n");

		knownMessageIds.add(triggerMessageId);

		ctx.logger.debug(`Sending ${allMessages.length} messages to AI (memory: ${!!memoryContext})`);

		const availableTools = createAvailableTools();

		const { output } = await generateText({
			model: openrouter!(env.OPENROUTER_MODEL),
			output: Output.object({ schema: chatResponseSchema }),
			system,
			messages: allMessages,
			...(availableTools.tools
				? {
						tools: availableTools.tools,
						stopWhen: stepCountIs(3),
						prepareStep: availableTools.prepareStep,
					}
				: {}),
			experimental_telemetry: getLangfuseTelemetry("message-reply", {
				chatId: String(ctx.chat.id),
				messageId: String(triggerMessageId),
				messageThreadId: String(messageThreadId ?? "main"),
				userId: ctx.message.from?.id ? String(ctx.message.from.id) : "unknown",
				sessionId: `${ctx.chat.id}:${messageThreadId ?? "main"}`,
			}),
			topP: 0.95,
			frequencyPenalty: 0.4,
			presencePenalty: 0.2,
		});

		if (!output) {
			ctx.logger.debug("No output from AI");
			return;
		}

		ctx.logger.debug(`Received ${output.replies.length} AI actions`);

		let sentTextCount = 0;

		for (const reply of output.replies) {
			if (reply.type === "reaction") {
				if (!knownMessageIds.has(reply.message_id)) {
					ctx.logger.debug(
						{ messageId: reply.message_id },
						"Skipping AI reaction: message ID not in known messages",
					);
					continue;
				}

				try {
					await ctx.api.setMessageReaction(ctx.chat.id, reply.message_id, [
						{ type: "emoji", emoji: reply.emoji },
					]);

					ctx.logger.debug({ messageId: reply.message_id, emoji: reply.emoji }, "Sent AI reaction");
				} catch (error) {
					if (error instanceof GrammyError) {
						ctx.logger.debug(
							{ error: error.message, messageId: reply.message_id, emoji: reply.emoji },
							"Could not send AI reaction",
						);
						continue;
					}

					throw error;
				}

				continue;
			}

			const replyText = stripBotAnnotations(reply.text);

			if (!replyText) {
				continue;
			}

			// null/undefined → plain chat message; number → reply to that specific id
			const replyToId = reply.reply_to ?? undefined;

			// Between burst messages, show typing and use a short human-like pause
			if (sentTextCount > 0) {
				await ctx.replyWithChatAction("typing").catch(() => {});
				await sleep(1_500, { minMs: 1_200, maxMs: 3_500 });
			}

			try {
				// Use bot.api (not ctx.api) to bypass the autoQuote transformer that would
				// otherwise force-inject reply_parameters pointing at the triggering message.
				const sentMessage = await bot.api.sendMessage(ctx.chat.id, replyText, {
					...(replyToId === undefined ? {} : { reply_parameters: { message_id: replyToId } }),
					message_thread_id: ctx.message.message_thread_id,
				});

				ctx.logger.debug(
					{ messageId: sentMessage.message_id },
					`Sent AI reply (replyTo: ${replyToId ?? "none"}, length: ${replyText.length})`,
				);

				await saveMessage({ ctx, msg: sentMessage });

				knownMessageIds.add(sentMessage.message_id);
				sentTextCount += 1;
			} catch (error) {
				if (error instanceof GrammyError) {
					ctx.logger.debug(
						{ error: error.message, replyTo: replyToId },
						"Could not send AI reply (message may have been deleted)",
					);
					continue;
				}

				throw error;
			}
		}
	});

export default composer;

import { env, type Prisma, prisma } from "@starlight/utils";
import { generateText } from "ai";
import { Composer } from "grammy";
import type { Context } from "@/bot";
import { upsertStoredMessage } from "@/middlewares/message";
import { getLangfuseTelemetry } from "@/otel";
import { buildChatMemoryPromptContext } from "@/services/chat-memory";
import { s3 } from "@/storage";
import {
	type ConversationMessage,
	type ConversationReplyReference,
	openrouter,
	shouldReplyToMessage,
	stripBotAnnotations,
	toConversationMessage,
	withMemorySystemPrompt,
} from "@/utils/message";
import { sleep } from "@/utils/tools";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);

const messageHistorySelect = {
	messageId: true,
	fromId: true,
	fromUsername: true,
	fromFirstName: true,
	text: true,
	caption: true,
	replyToMessageId: true,
	attachments: {
		select: {
			id: true,
			s3Path: true,
			mimeType: true,
		},
		orderBy: {
			id: "asc",
		},
	},
} satisfies Prisma.MessageSelect;

type StoredConversationMessage = Prisma.MessageGetPayload<{
	select: typeof messageHistorySelect;
}>;

type StoredConversationMessageWithInlineVideo = Omit<StoredConversationMessage, "attachments"> & {
	attachments: Array<StoredConversationMessage["attachments"][number] & { base64Data?: string }>;
};

type ReplyToMessage = NonNullable<NonNullable<Context["message"]>["reply_to_message"]>;

const RESPONSE_DELAY_MS = 1500;

async function hasNewerHumanMessage(params: {
	chatId: bigint;
	messageId: number;
	messageThreadId: number | null;
}): Promise<boolean> {
	const newerMessage = await prisma.message.findFirst({
		where: {
			chatId: params.chatId,
			messageThreadId: params.messageThreadId,
			deletedAt: null,
			messageId: {
				gt: params.messageId,
			},
			fromId: {
				not: null,
			},
			rawData: {
				path: ["from", "is_bot"],
				equals: false,
			},
		},
		select: {
			messageId: true,
		},
		orderBy: {
			messageId: "desc",
		},
	});

	return newerMessage !== null;
}

async function inlineVideoAttachments(
	ctx: Context,
	entry: StoredConversationMessage,
): Promise<StoredConversationMessageWithInlineVideo> {
	if (entry.attachments.length === 0) {
		return entry;
	}

	const attachments = await Promise.all(
		entry.attachments.map(async (attachment) => {
			if (!attachment.mimeType.startsWith("video/")) {
				return attachment;
			}

			try {
				const payload = await s3.file(attachment.s3Path).arrayBuffer();

				return {
					...attachment,
					base64Data: Buffer.from(payload).toString("base64"),
				};
			} catch (error) {
				ctx.logger.warn(
					{
						error,
						messageId: entry.messageId,
						s3Path: attachment.s3Path,
						mimeType: attachment.mimeType,
					},
					"Failed to inline video attachment for provider payload",
				);

				return attachment;
			}
		}),
	);

	return {
		...entry,
		attachments,
	};
}

function toReplyReferenceFromStoredMessage(
	entry: Pick<
		StoredConversationMessageWithInlineVideo,
		"fromId" | "fromUsername" | "fromFirstName" | "text" | "caption" | "attachments"
	>,
): ConversationReplyReference {
	return {
		fromId: entry.fromId,
		fromUsername: entry.fromUsername,
		fromFirstName: entry.fromFirstName,
		text: entry.text,
		caption: entry.caption,
		attachments: entry.attachments.map((attachment) => ({
			mimeType: attachment.mimeType,
		})),
	};
}

const MEDIA_MIME_EXTRACTORS: Array<{
	key: keyof ReplyToMessage;
	getMime: (msg: ReplyToMessage) => string;
}> = [
	{ key: "photo", getMime: () => "image/jpeg" },
	{
		key: "sticker",
		getMime: (msg) =>
			(msg.sticker as { is_video?: boolean })?.is_video ? "video/webm" : "image/webp",
	},
	{
		key: "video",
		getMime: (msg) => (msg.video as { mime_type?: string })?.mime_type ?? "video/mp4",
	},
	{
		key: "animation",
		getMime: (msg) => (msg.animation as { mime_type?: string })?.mime_type ?? "video/mp4",
	},
	{ key: "video_note", getMime: () => "video/mp4" },
	{
		key: "voice",
		getMime: (msg) => (msg.voice as { mime_type?: string })?.mime_type ?? "audio/ogg",
	},
	{
		key: "audio",
		getMime: (msg) => (msg.audio as { mime_type?: string })?.mime_type ?? "audio/mpeg",
	},
	{
		key: "document",
		getMime: (msg) =>
			(msg.document as { mime_type?: string })?.mime_type ?? "application/octet-stream",
	},
];

function extractReplyAttachmentMimeTypes(message: ReplyToMessage): Array<{ mimeType: string }> {
	const attachments: Array<{ mimeType: string }> = [];

	for (const { key, getMime } of MEDIA_MIME_EXTRACTORS) {
		const value = message[key];
		if (key === "photo" ? Array.isArray(value) && value.length > 0 : value) {
			attachments.push({ mimeType: getMime(message) });
		}
	}

	return attachments;
}

function toReplyReferenceFromTelegramMessage(message: ReplyToMessage): ConversationReplyReference {
	return {
		fromId: message.from ? BigInt(message.from.id) : null,
		fromUsername: message.from?.username ?? null,
		fromFirstName: message.from?.first_name ?? null,
		text: message.text ?? null,
		caption: message.caption ?? null,
		attachments: extractReplyAttachmentMimeTypes(message),
	};
}

const isAdminOrCreator = async (ctx: Context) => {
	if (!(ctx.from && ctx.chat)) {
		return false;
	}

	if (env.SUPERVISOR_IDS.includes(ctx.from.id)) {
		return true;
	}

	const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);

	return member.status === "administrator" || member.status === "creator";
};

groupChat.command("clear", async (ctx) => {
	if (!(await isAdminOrCreator(ctx))) {
		await ctx.reply("Only admins, creators, and supervisors can use this command.");
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
	(ctx) => shouldReplyToMessage(ctx, ctx.message, ctx.chatMemorySettings.botAliases),
	async (ctx) => {
		if (!openrouter) {
			ctx.logger.debug("OPENROUTER_API_KEY is not set, skipping AI reply");
			return;
		}

		const triggerMessageId = ctx.message.message_id;
		const messageThreadId = ctx.message.message_thread_id ?? null;
		const chatId = BigInt(ctx.chat.id);

		await sleep(RESPONSE_DELAY_MS);

		if (
			await hasNewerHumanMessage({
				chatId,
				messageId: triggerMessageId,
				messageThreadId,
			})
		) {
			ctx.logger.debug(
				{ chatId: ctx.chat.id, messageId: triggerMessageId, messageThreadId },
				"Skipping stale AI reply after response delay",
			);
			return;
		}

		const history = await prisma.message.findMany({
			where: {
				chatId,
				messageThreadId,
				messageId: {
					not: ctx.message.message_id,
				},
				OR: [{ text: { not: null } }, { caption: { not: null } }, { attachments: { some: {} } }],
			},
			select: messageHistorySelect,
			orderBy: {
				date: "desc",
			},
			take: env.HISTORY_LIMIT,
		});

		const historyWithInlineVideo = await Promise.all(
			history.map((entry) => inlineVideoAttachments(ctx, entry)),
		);

		const botId = BigInt(ctx.me.id);
		const storedMessageById = new Map<number, StoredConversationMessageWithInlineVideo>(
			historyWithInlineVideo.map((entry) => [entry.messageId, entry]),
		);

		const repliedMessage = ctx.message.reply_to_message;

		const missingReplyIds: number[] = [];
		for (const entry of historyWithInlineVideo) {
			if (entry.replyToMessageId !== null && !storedMessageById.has(entry.replyToMessageId)) {
				missingReplyIds.push(entry.replyToMessageId);
			}
		}
		if (repliedMessage && !storedMessageById.has(repliedMessage.message_id)) {
			missingReplyIds.push(repliedMessage.message_id);
		}

		if (missingReplyIds.length > 0) {
			const referencedMessages = await prisma.message.findMany({
				where: {
					chatId,
					messageId: { in: missingReplyIds },
				},
				select: messageHistorySelect,
			});

			const referencedWithInlineVideo = await Promise.all(
				referencedMessages.map((entry) => inlineVideoAttachments(ctx, entry)),
			);

			for (const entry of referencedWithInlineVideo) {
				storedMessageById.set(entry.messageId, entry);
			}
		}

		const messages: ConversationMessage[] = historyWithInlineVideo
			.reverse()
			.map((entry) => {
				const replyToEntry =
					entry.replyToMessageId !== null
						? (storedMessageById.get(entry.replyToMessageId) ?? null)
						: null;

				return toConversationMessage(
					{
						...entry,
						replyTo: replyToEntry ? toReplyReferenceFromStoredMessage(replyToEntry) : null,
					},
					botId,
				);
			})
			.filter((entry): entry is ConversationMessage => entry !== null);

		const storedRepliedMessage = repliedMessage
			? (storedMessageById.get(repliedMessage.message_id) ?? null)
			: null;

		let currentReplyReference: ConversationReplyReference | null = null;
		if (storedRepliedMessage) {
			currentReplyReference = toReplyReferenceFromStoredMessage(storedRepliedMessage);
		} else if (repliedMessage) {
			currentReplyReference = toReplyReferenceFromTelegramMessage(repliedMessage);
		}

		const currentMessageAttachments = ctx.currentMessageAttachments;

		const currentMessageEntry = {
			fromId: ctx.message.from ? BigInt(ctx.message.from.id) : null,
			fromUsername: ctx.message.from?.username ?? null,
			fromFirstName: ctx.message.from?.first_name ?? null,
			text: ctx.message.text ?? null,
			caption: ctx.message.caption ?? null,
			attachments: currentMessageAttachments,
			replyTo: currentReplyReference,
		};

		const currentConversationMessage = toConversationMessage(currentMessageEntry, botId);

		if (!currentConversationMessage) {
			return;
		}

		messages.push(currentConversationMessage);

		const memoryContext = await buildChatMemoryPromptContext({
			chatId,
			chatSettings: ctx.userChat?.settings ?? null,
			messageThreadId,
		});
		const systemPrompt = withMemorySystemPrompt(memoryContext);

		await ctx.replyWithChatAction("typing");

		const { text } = await generateText({
			model: openrouter(env.OPENROUTER_MODEL),
			system: systemPrompt,
			messages,
			experimental_telemetry: getLangfuseTelemetry("message-reply", {
				chatId: String(ctx.chat.id),
				messageId: String(ctx.message.message_id),
				messageThreadId: String(ctx.message.message_thread_id ?? "main"),
				userId: ctx.message.from?.id ? String(ctx.message.from.id) : "unknown",
				sessionId: `${ctx.chat.id}:${ctx.message.message_thread_id ?? "main"}`,
			}),
			experimental_download: async (downloads) => downloads.map(() => null),
			temperature: 0.75,
			topK: 80,
		});

		const reply = stripBotAnnotations(text);
		if (!reply) {
			return;
		}

		if (
			await hasNewerHumanMessage({
				chatId,
				messageId: triggerMessageId,
				messageThreadId,
			})
		) {
			ctx.logger.debug(
				{ chatId: ctx.chat.id, messageId: triggerMessageId, messageThreadId },
				"Skipping stale AI reply after inference",
			);
			return;
		}

		const sentMessage = await ctx.api.sendMessage(ctx.chat.id, reply, {
			reply_to_message_id: ctx.message.message_id,
			message_thread_id: ctx.message.message_thread_id,
		});

		await upsertStoredMessage(ctx, sentMessage);
	},
);

export default composer;

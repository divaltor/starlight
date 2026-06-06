import type { Message, MessageEntity } from "@grammyjs/types";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { attachmentLabelFromMimeType, env } from "@starlight/utils";
import type { FilePart, ImagePart, ModelMessage, TextPart } from "ai";
import { format } from "date-fns";
import type { Context } from "@/bot";
import SYSTEM_PROMPT from "@/utils/system-prompt.txt" with { type: "text" };

const REPLY_CHANCE = 0.01;

const LOW_SIGNAL_TOKEN_ALLOWLIST = new Set([
	"ок",
	"окей",
	"к",
	"кк",
	"ага",
	"угу",
	"ясно",
	"пон",
	"понял",
	"поняла",
	"да",
	"нет",
	"хз",
	"лол",
	"ору",
	"ахах",
	"хаха",
	"хд",
	"мм",
	"м",
	"эм",
	"спс",
	"спасибо",
]);

export function getSystemPrompt(now: Date = new Date()): string {
	return `${SYSTEM_PROMPT}\nCurrent date: ${format(now, "yyyy-MM-dd")}`;
}

export interface AssistantConversationTurn {
	attachments: [];
	context: [];
	includeAttachmentData: false;
	messageId: number;
	replyToMessageId: number | null;
	role: "assistant";
	text: string;
}

export interface UserConversationTurn {
	attachments: ConversationAttachment[];
	context: string[];
	includeAttachmentData: boolean;
	messageId: number;
	replyToMessageId: number | null;
	role: "user";
	senderName: string;
	text: string | null;
}

export type ConversationTurn = AssistantConversationTurn | UserConversationTurn;

const OPENROUTER_GEMINI_3_FLASH_MODEL_PREFIX = "google/gemini-3-flash";

export interface ConversationAttachment {
	base64Data?: string;
	mimeType: string;
	s3Path: string;
	summary?: string | null;
}

export interface ToConversationTurnOptions {
	includeAttachmentData?: boolean;
	supplementalAttachments?: ConversationAttachment[];
	supplementalContent?: string[];
}

export interface ToModelMessageOptions {
	includeAttachmentData?: boolean;
}

interface ConversationTurnEntry {
	attachments: ConversationAttachment[];
	caption?: string | null;
	fromFirstName?: string | null;
	fromId?: number | bigint | null;
	fromUsername?: string | null;
	messageId: number;
	messageThreadId?: number | null;
	replyToMessageId?: number | null;
	text?: string | null;
}

export const openrouter = env.OPENROUTER_API_KEY
	? createOpenRouter({
			apiKey: env.OPENROUTER_API_KEY,
			headers: { "X-OpenRouter-Title": env.APP_NAME },
		})
	: null;

export function getMessageContent(msg: Pick<Message, "text" | "caption">): string | null {
	return (msg.text ?? msg.caption)?.trim() || null;
}

export function hasMessageAttachments(
	msg: Pick<Message, "photo" | "sticker" | "video" | "animation" | "video_note" | "voice">,
): boolean {
	return Boolean(
		(msg.photo && msg.photo.length > 0) ||
		msg.sticker ||
		msg.video ||
		msg.animation ||
		msg.video_note ||
		msg.voice,
	);
}

function getTextWithEntities(msg: Message): {
	text: string;
	entities: MessageEntity[];
} | null {
	if (msg.text) {
		return {
			text: msg.text,
			entities: msg.entities ?? [],
		};
	}

	if (msg.caption) {
		return {
			text: msg.caption,
			entities: msg.caption_entities ?? [],
		};
	}

	return null;
}

function hasDirectBotMention(ctx: Context, msg: Message): boolean {
	const botUsername = ctx.me.username.toLowerCase();
	const mentionData = getTextWithEntities(msg);
	if (!mentionData) {
		return false;
	}

	const mention = `@${botUsername}`;

	for (const entity of mentionData.entities) {
		if (entity.type !== "mention") {
			continue;
		}

		const entityText = mentionData.text
			.slice(entity.offset, entity.offset + entity.length)
			.toLowerCase();

		if (entityText === mention) {
			return true;
		}
	}

	return mentionData.text.toLowerCase().includes(mention);
}

function hasBotAliasMention(msg: Message, botAliases: readonly string[]): boolean {
	if (botAliases.length === 0) {
		return false;
	}

	const content = getMessageContent(msg);

	if (!content) {
		return false;
	}

	const normalizedContent = content.toLowerCase();

	return botAliases.some((alias) => {
		const normalizedAlias = alias.trim().toLowerCase();

		const escapedAlias = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

		const aliasPattern = new RegExp(
			`(?:^|[^\\p{L}\\p{N}_@])${escapedAlias}(?:$|[^\\p{L}\\p{N}_])`,
			"u",
		);

		return aliasPattern.test(normalizedContent);
	});
}

function isCommandMessage(msg: Message): boolean {
	const textData = getTextWithEntities(msg);

	if (!textData) {
		return false;
	}

	if (textData.entities.some((entity) => entity.type === "bot_command")) {
		return true;
	}

	return textData.text.trimStart().startsWith("/");
}

function isLowSignalMessageText(text: string): boolean {
	const normalized = text.trim().toLowerCase();

	if (!normalized || normalized.length > 24) {
		return false;
	}

	if (normalized.includes("http://") || normalized.includes("https://")) {
		return false;
	}

	if (/^[\p{P}\p{S}\s]+$/u.test(normalized)) {
		return true;
	}

	const tokens = normalized
		.split(/\s+/)
		.map((token) => token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""))
		.filter(Boolean);

	if (tokens.length === 0 || tokens.length > 4) {
		return false;
	}

	return tokens.every((token) => LOW_SIGNAL_TOKEN_ALLOWLIST.has(token));
}

function shouldIgnoreMessage(ctx: Context, msg: Message): boolean {
	if (ctx.chat?.type === "private") {
		return true;
	}

	if (isCommandMessage(msg)) {
		return true;
	}

	const content = getMessageContent(msg);
	if (!content) {
		return true;
	}

	if (!isLowSignalMessageText(content)) {
		return true;
	}

	return Math.random() > env.IGNORE_USER_CHANCE;
}

export function shouldReplyToMessage(ctx: Context, msg: Message): boolean {
	if (msg.from?.is_bot) {
		return false;
	}

	if (!(getMessageContent(msg) || hasMessageAttachments(msg))) {
		return false;
	}

	const hasBotMention = hasDirectBotMention(ctx, msg) || hasBotAliasMention(msg, env.BOT_ALIASES);

	if (msg.forward_origin && hasBotMention) {
		return false;
	}

	if (hasBotMention) {
		return true;
	}

	// Is reply to bot message
	if (msg.reply_to_message?.from?.id === ctx.me.id) {
		return true;
	}

	if (Math.random() >= REPLY_CHANCE) {
		return false;
	}

	return shouldIgnoreMessage(ctx, msg);
}

export function formatSenderName(data: {
	fromUsername?: string | null;
	fromFirstName?: string | null;
	fromId?: number | bigint | null;
}): string {
	if (data.fromUsername) {
		return `@${data.fromUsername}`;
	}

	if (data.fromFirstName) {
		return data.fromFirstName;
	}

	if (data.fromId !== null) {
		return `user_${data.fromId}`;
	}

	return "unknown";
}

const BOT_ANNOTATION_RE = /\n?\[(?:reply to [^\]]*|attachment)\]/g;

const BOT_USERNAME_PREFIX_RE = /^@\w+:?\s*/;

export function stripBotAnnotations(text: string): string {
	return text.replace(BOT_ANNOTATION_RE, "").trim().replace(BOT_USERNAME_PREFIX_RE, "");
}

function toAttachmentUrl(s3Path: string): URL | null {
	if (!env.BASE_CDN_URL) {
		return null;
	}

	const baseUrl = env.BASE_CDN_URL.replace(/\/+$/, "");
	const normalizedPath = s3Path.replace(/^\/+/, "");
	const fullUrl = `${baseUrl}/${normalizedPath}`;

	return new URL(fullUrl);
}

export function toConversationTurn(
	entry: ConversationTurnEntry,
	botId: number,
	{
		includeAttachmentData = true,
		supplementalAttachments = [],
		supplementalContent = [],
	}: ToConversationTurnOptions = {},
): ConversationTurn {
	const content = entry.text?.trim() ?? entry.caption?.trim() ?? null;
	const attachments = [...entry.attachments, ...supplementalAttachments];
	const replyToMessageId = entry.replyToMessageId ?? null;
	const messageThreadId = entry.messageThreadId ?? null;

	if (entry.fromId != null && Number(entry.fromId) === botId) {
		return {
			attachments: [],
			context: [],
			includeAttachmentData: false,
			messageId: entry.messageId,
			replyToMessageId,
			role: "assistant",
			text: stripBotAnnotations(content!),
		};
	}

	const sender = formatSenderName(entry);

	const attachmentLabels =
		attachments.length > 0
			? attachments.map((attachment) => attachmentLabelFromMimeType(attachment.mimeType))
			: [];

	// If we send message to a topic - Telelegram set `reply_to_message` as first system message from that topic. Insane
	const isTopicRootReply =
		replyToMessageId !== null && messageThreadId !== null && replyToMessageId === messageThreadId;

	const normalizedReplyToMessageId = isTopicRootReply ? null : replyToMessageId;

	const context: string[] = [];

	if (normalizedReplyToMessageId !== null) {
		context.push(`Replying to message #${normalizedReplyToMessageId}`);
	}

	if (attachmentLabels.length > 0) {
		context.push(`Sent attachments: ${attachmentLabels.join(", ")}`);
	}

	const attachmentSummaries = attachments
		.map((attachment) => (attachment.summary ?? "").trim())
		.filter((summary) => summary.length > 0);

	if (attachmentSummaries.length > 0) {
		context.push(
			`Attachment context:\n${attachmentSummaries.map((summary, index) => `${index + 1}. ${summary}`).join("\n")}`,
		);
	}

	for (const [index, block] of supplementalContent.entries()) {
		context.push(`Linked context #${index + 1}:\n${block}`);
	}

	return {
		attachments,
		context,
		includeAttachmentData,
		messageId: entry.messageId,
		replyToMessageId: normalizedReplyToMessageId,
		role: "user",
		senderName: sender,
		text: content,
	};
}

export function toModelMessage(
	turn: ConversationTurn,
	options: ToModelMessageOptions = {},
): ModelMessage {
	if (turn.role === "assistant") {
		return {
			role: "assistant",
			content: turn.text,
		};
	}

	const includeAttachmentData = options.includeAttachmentData ?? turn.includeAttachmentData;
	const parts: Array<TextPart | ImagePart | FilePart> = [];
	const messageLabel = `Message #${turn.messageId} from ${turn.senderName}`;

	parts.push({ type: "text", text: messageLabel });

	if (turn.text) {
		parts.push({ type: "text", text: turn.text });
	}

	for (const block of turn.context) {
		parts.push({ type: "text", text: block });
	}

	if (!includeAttachmentData) {
		return {
			role: "user",
			content: parts,
		};
	}

	for (const attachment of turn.attachments) {
		const attachmentData = attachment.base64Data ?? toAttachmentUrl(attachment.s3Path);

		if (!attachmentData) {
			continue;
		}

		if (attachment.mimeType.startsWith("image/")) {
			parts.push({
				type: "image",
				image: attachmentData,
				mediaType: attachment.mimeType,
			});
			continue;
		}

		parts.push({
			type: "file",
			data: attachmentData,
			mediaType: attachment.mimeType,
		});
	}

	return {
		role: "user",
		content: parts,
	};
}

export function withOpenRouterGeminiCacheControl(
	messages: ModelMessage[],
	model: string,
): ModelMessage[] {
	if (!model.startsWith(OPENROUTER_GEMINI_3_FLASH_MODEL_PREFIX)) {
		return messages;
	}

	// Gemini uses the last cache_control breakpoint as "cache everything up to here".
	// Skip the current request so volatile user text, memory, and tool context stay uncached.
	for (let messageIndex = messages.length - 2; messageIndex >= 0; messageIndex -= 1) {
		const message = messages[messageIndex];

		if (!message || message.role !== "user" || !Array.isArray(message.content)) {
			continue;
		}

		if (!message.content.every((part) => part.type === "text")) {
			continue;
		}

		for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = message.content[partIndex];

			if (!part || part.type !== "text") {
				continue;
			}

			message.content[partIndex] = {
				...part,
				providerOptions: {
					openrouter: {
						cache_control: { type: "ephemeral" },
					},
				},
			};

			return messages;
		}
	}

	return messages;
}

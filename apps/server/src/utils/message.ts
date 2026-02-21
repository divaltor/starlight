import type { Message, MessageEntity } from "@grammyjs/types";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { env } from "@starlight/utils";
import type { Context } from "@/bot";

const REPLY_CHANCE = 0.1;

export const SYSTEM_PROMPT = `You are Starlight, a concise Telegram assistant in a group chat.
Keep answers short and useful.
Use plain text only.
If message context is not enough, ask one short clarifying question.`;

export interface ConversationMessage {
	content: string;
	role: "user" | "assistant";
}

export const openrouter = env.OPENROUTER_API_KEY
	? createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })
	: null;

export function getMessageContent(
	msg: Pick<Message, "text" | "caption">
): string | null {
	const content = msg.text ?? msg.caption;

	if (!content) {
		return null;
	}

	const trimmed = content.trim();
	return trimmed.length > 0 ? trimmed : null;
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
	const botUsername = ctx.me.username?.toLowerCase();

	if (!botUsername) {
		return false;
	}

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

export function shouldReplyToMessage(ctx: Context, msg: Message): boolean {
	if (msg.from?.is_bot) {
		return false;
	}

	if (!getMessageContent(msg)) {
		return false;
	}

	return hasDirectBotMention(ctx, msg) || Math.random() < REPLY_CHANCE;
}

export function formatSenderName(data: {
	fromUsername: string | null;
	fromFirstName: string | null;
	fromId: bigint | null;
}): string {
	if (data.fromUsername) {
		return `@${data.fromUsername}`;
	}

	if (data.fromFirstName) {
		return data.fromFirstName;
	}

	if (data.fromId !== null) {
		return `user_${data.fromId.toString()}`;
	}

	return "unknown";
}

export function toConversationMessage(
	entry: {
		fromId: bigint | null;
		fromUsername: string | null;
		fromFirstName: string | null;
		text: string | null;
		caption: string | null;
	},
	botId: bigint
): ConversationMessage | null {
	const content = (entry.text ?? entry.caption)?.trim();

	if (!content) {
		return null;
	}

	if (entry.fromId !== null && entry.fromId === botId) {
		return {
			role: "assistant",
			content,
		};
	}

	const sender = formatSenderName(entry);
	return {
		role: "user",
		content: `${sender}: ${content}`,
	};
}

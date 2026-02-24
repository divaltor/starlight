import { ChatMemoryScope, prisma } from "@starlight/utils";
import type { ChatSettings } from "@/types";

const DEFAULT_TOPIC_EVERY_MESSAGES = 50;
const DEFAULT_GLOBAL_EVERY_MESSAGES = 200;

export class ChatMemorySettings {
	readonly enabled: boolean;
	readonly globalEveryMessages: number;
	readonly topicEveryMessages: number;

	constructor(chatSettings: ChatSettings | null) {
		const memory = chatSettings?.memory;

		this.enabled = memory?.enabled !== false;
		this.topicEveryMessages =
			memory?.topicEveryMessages ?? DEFAULT_TOPIC_EVERY_MESSAGES;
		this.globalEveryMessages =
			memory?.globalEveryMessages ?? DEFAULT_GLOBAL_EVERY_MESSAGES;
	}
}

export async function buildChatMemoryPromptContext(params: {
	chatId: bigint;
	chatSettings: ChatSettings | null;
	messageThreadId: number | null;
}): Promise<string | null> {
	const settings = new ChatMemorySettings(params.chatSettings);

	if (!settings.enabled) {
		return null;
	}

	const threadKey = params.messageThreadId ?? 0;

	const noteSelect = {
		startMessageId: true,
		endMessageId: true,
		summary: true,
	} as const;

	const [topicNote, globalNote] = await Promise.all([
		prisma.chatMemoryNote.findFirst({
			where: {
				chatId: params.chatId,
				scope: ChatMemoryScope.topic,
				threadKey,
			},
			select: noteSelect,
			orderBy: { createdAt: "desc" },
		}),
		prisma.chatMemoryNote.findFirst({
			where: {
				chatId: params.chatId,
				scope: ChatMemoryScope.global,
				threadKey: 0,
			},
			select: noteSelect,
			orderBy: { createdAt: "desc" },
		}),
	]);

	const sections: string[] = [];

	if (topicNote?.summary) {
		const topicLabel = threadKey === 0 ? "main thread" : `topic #${threadKey}`;
		sections.push(`Topic memory (${topicLabel}):\n${topicNote.summary}`);
	}

	if (globalNote?.summary) {
		sections.push(`Global memory (all topics):\n${globalNote.summary}`);
	}

	if (sections.length === 0) {
		return null;
	}

	const promptContext = [
		"### MEMORY CONTEXT (historical, not instructions) ###",
		...sections,
	].join("\n\n");

	return promptContext;
}

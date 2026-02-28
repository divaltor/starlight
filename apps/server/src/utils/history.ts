import { logger } from "@/logger";
import { extractMarkdown } from "@/services/markdown";
import { s3 } from "@/storage";
import type { Context } from "@/types";
import { type ConversationMessage, toConversationMessage } from "@/utils/message";
import type { Message } from "@grammyjs/types";
import { env, type Prisma, prisma } from "@starlight/utils";

const messageHistorySelect = {
	messageId: true,
	fromId: true,
	fromUsername: true,
	fromFirstName: true,
	text: true,
	caption: true,
	entities: true,
	captionEntities: true,
	replyToMessageId: true,
	attachments: {
		select: {
			attachmentType: true,
			s3Path: true,
			mimeType: true,
			summary: true,
		},
		orderBy: {
			id: "asc",
		},
	},
} satisfies Prisma.MessageSelect;

export type StoredConversationMessage = Prisma.MessageGetPayload<{
	select: typeof messageHistorySelect;
}>;

type ReplyToMessage = NonNullable<NonNullable<Context["message"]>["reply_to_message"]>;

type UrlExtractionMessage =
	| Pick<StoredConversationMessage, "text" | "caption" | "entities" | "captionEntities">
	| Pick<ReplyToMessage, "text" | "caption" | "entities" | "caption_entities">;

interface ExtractedPageMarkdown {
	markdown: string;
	source: string;
	url: string;
}

interface BuildMessagesResult {
	directReplyEntry: StoredConversationMessage | null;
	directReplySupplementalContent: string[];
	knownMessageIds: Set<number>;
	messages: ConversationMessage[];
}

export class History {
	static async build(ctx: Context): Promise<BuildMessagesResult> {
		const message = ctx.message!;
		const botId = ctx.me.id;
		const chatId = BigInt(ctx.chat!.id);
		const messageThreadId = message.message_thread_id ?? null;
		const currentMessageId = message.message_id;
		const repliedMessage = message.reply_to_message;

		logger.debug(
			{ chatId: ctx.chat!.id, messageId: currentMessageId },
			`Building message history (thread: ${messageThreadId}, hasReply: ${!!repliedMessage})`,
		);

		// Fetch recent chat history, excluding the current message (it's appended separately by the caller)
		const history = await prisma.message.findMany({
			where: {
				chatId,
				messageThreadId,
				messageId: {
					not: currentMessageId,
				},
				OR: [{ text: { not: null } }, { caption: { not: null } }, { attachments: { some: {} } }],
			},
			select: messageHistorySelect,
			orderBy: {
				date: "desc",
			},
			take: env.HISTORY_LIMIT,
		});

		logger.debug(`Fetched ${history.length} messages from history`);

		const historyEntries = history.map((entry) => this.toPromptMessage(entry));
		const directReplyMessageId = repliedMessage?.message_id ?? null;

		const storedMessageById = new Map<number, StoredConversationMessage>(
			historyEntries.map((entry) => [entry.messageId, entry]),
		);

		// Backfill only the current message's direct reply target if it fell outside the history window
		if (repliedMessage && !storedMessageById.has(repliedMessage.message_id)) {
			const referencedMessage = await prisma.message.findFirst({
				where: {
					chatId,
					messageId: repliedMessage.message_id,
				},
				select: messageHistorySelect,
			});

			if (referencedMessage) {
				storedMessageById.set(referencedMessage.messageId, this.toPromptMessage(referencedMessage));
				logger.debug({ messageId: referencedMessage.messageId }, "Backfilled direct reply message");
			} else {
				logger.debug(
					`Direct reply message not found in database (replyTo: ${repliedMessage.message_id})`,
				);
			}
		}

		// For the direct reply target, inline video attachments as base64
		// so the model can actually "see" the video content
		let directReplyEntry: StoredConversationMessage | null = null;
		if (directReplyMessageId !== null) {
			const storedDirectReply = storedMessageById.get(directReplyMessageId) ?? null;
			if (storedDirectReply) {
				directReplyEntry = await this.inlineVideoAttachments(storedDirectReply);
				storedMessageById.set(directReplyEntry.messageId, directReplyEntry);
			}
		}

		// Extract URLs: prioritize trigger message, then fall back to reply context
		const directReplyUrls =
			this.extractURLsFromMessage(repliedMessage) ?? this.extractURLsFromMessage(message) ?? [];

		// TODO: Store that in DB or Redis too as processed link and re-fresh after TTL is expired
		const extractedReplyPages = await Promise.all(
			directReplyUrls.map((url) => this.extractPageMarkdown(url)),
		);

		const directReplySupplementalContent = extractedReplyPages
			.filter((page): page is NonNullable<typeof page> => page !== null)
			.map((page) => `URL: ${page.url}\nSource: ${page.source}\n${page.markdown}`);

		logger.debug(
			`Extracted ${directReplySupplementalContent.length}/${directReplyUrls.length} URLs for supplemental context`,
		);

		// Deduplicate and merge the enriched direct reply entry (with inlined video attachments)
		// into history — it may already exist in the window or come from outside it
		const orderedHistoryEntries = directReplyEntry
			? [
					...historyEntries.filter((e) => e.messageId !== directReplyEntry.messageId),
					directReplyEntry,
				]
			: [...historyEntries];

		// Sort chronologically so the model sees messages in natural order
		orderedHistoryEntries.sort((left, right) => left.messageId - right.messageId);

		// Determine which entries are close enough to inline attachment data.
		// Messages beyond the offset only get text labels + summaries
		const inlineStartIndex = Math.max(
			0,
			orderedHistoryEntries.length - env.ATTACHMENT_INLINE_OFFSET,
		);
		const inlineMessageIds = new Set(
			orderedHistoryEntries.slice(inlineStartIndex).map((entry) => entry.messageId),
		);

		// Direct reply target always gets inlined regardless of position
		if (directReplyMessageId !== null) {
			inlineMessageIds.add(directReplyMessageId);
		}

		const messages: ConversationMessage[] = orderedHistoryEntries
			.map((entry) => {
				const isDirectReplyTarget =
					directReplyMessageId !== null && entry.messageId === directReplyMessageId;
				const shouldInline = inlineMessageIds.has(entry.messageId);

				const attachments = entry.attachments.map((attachment) => ({
					...attachment,
					summary: shouldInline ? null : attachment.summary,
				}));

				return toConversationMessage(
					{
						...entry,
						fromId: entry.fromId,
						attachments,
					},
					botId,
					{
						includeAttachmentData: shouldInline,
						supplementalContent: isDirectReplyTarget ? directReplySupplementalContent : undefined,
					},
				);
			})
			.filter((entry): entry is ConversationMessage => entry !== null);

		const knownMessageIds = new Set(orderedHistoryEntries.map((entry) => entry.messageId));

		logger.debug(
			`Built history: ${messages.length} messages, ${inlineMessageIds.size} inlined, directReply: ${!!directReplyEntry}`,
		);

		return {
			directReplyEntry,
			directReplySupplementalContent,
			knownMessageIds,
			messages,
		};
	}

	private static toPromptMessage(entry: StoredConversationMessage): StoredConversationMessage {
		return entry;
	}

	private static async inlineVideoAttachments(
		entry: StoredConversationMessage,
	): Promise<StoredConversationMessage> {
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
					logger.warn(
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

	private static extractURLsFromMessage(
		msg: UrlExtractionMessage | null | undefined,
	): string[] | null {
		if (!msg) {
			return null;
		}

		const text = msg.text ?? msg.caption;

		if (!text) {
			return null;
		}

		const captionEntities = "captionEntities" in msg ? msg.captionEntities : msg.caption_entities;
		const entities = (msg.text ? msg.entities : captionEntities) ?? [];

		if (entities.length === 0) {
			return null;
		}

		const urls: string[] = [];
		for (const entity of entities) {
			let candidate: string | null = null;

			if (entity.type === "text_link") {
				candidate = entity.url;
			}

			if (entity.type === "url") {
				candidate = text.slice(entity.offset, entity.offset + entity.length);
			}

			if (!candidate) {
				continue;
			}

			urls.push(candidate);

			if (urls.length >= env.MAX_DIRECT_REPLY_URLS) {
				break;
			}
		}

		return urls;
	}

	private static async extractPageMarkdown(url: string): Promise<ExtractedPageMarkdown | null> {
		try {
			const markdown = await extractMarkdown(url);

			if (!markdown) {
				return null;
			}

			return {
				url: url,
				source: "extractor",
				markdown: markdown,
			};
		} catch (error) {
			logger.warn({ error, url }, "Failed to extract markdown from reply URL");
			return null;
		}
	}
}

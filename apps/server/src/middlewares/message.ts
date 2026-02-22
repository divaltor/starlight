import { prisma } from "@starlight/utils";
import type { NextFunction } from "grammy";
import type { Message } from "grammy/types";
import type { Context } from "@/types";
import { prepareMessageAttachments } from "@/utils/attachment";

function detectMediaType(msg: Message): string | null {
	if (msg.photo) return "photo";
	if (msg.video) return "video";
	if (msg.animation) return "animation";
	if (msg.document) return "document";
	if (msg.audio) return "audio";
	if (msg.voice) return "voice";
	if (msg.video_note) return "video_note";
	if (msg.sticker) return "sticker";
	if (msg.poll) return "poll";
	if (msg.contact) return "contact";
	if (msg.location) return "location";
	if (msg.venue) return "venue";
	if (msg.dice) return "dice";
	return null;
}

function buildMessageData(chatId: bigint, msg: Message) {
	return {
		messageId: msg.message_id,
		chatId,
		fromId: msg.from ? BigInt(msg.from.id) : null,
		fromUsername: msg.from?.username,
		fromFirstName: msg.from?.first_name,
		text: msg.text,
		caption: msg.caption,
		entities: msg.entities,
		captionEntities: msg.caption_entities,
		mediaType: detectMediaType(msg),
		replyToMessageId: msg.reply_to_message?.message_id ?? null,
		messageThreadId: msg.message_thread_id ?? null,
		forwardOrigin: msg.forward_origin,
		rawData: msg,
		date: new Date(msg.date * 1000),
		editDate: msg.edit_date ? new Date(msg.edit_date * 1000) : null,
	};
}

async function syncUserFromMessage(
	msg: Message
): Promise<{ isBot: boolean } | null> {
	if (!msg.from) {
		return null;
	}

	return await prisma.user.upsert({
		where: {
			telegramId: msg.from.id,
		},
		create: {
			telegramId: msg.from.id,
			username: msg.from.username,
			firstName: msg.from.first_name,
			lastName: msg.from.last_name,
			isBot: msg.from.is_bot,
		},
		update: {
			username: msg.from.username,
			firstName: msg.from.first_name,
			lastName: msg.from.last_name,
			isBot: msg.from.is_bot,
		},
		select: {
			isBot: true,
		},
	});
}

export async function upsertStoredMessage(ctx: Context, msg: Message) {
	const parsedChatId = BigInt(msg.chat.id);
	const data = buildMessageData(parsedChatId, msg);
	const attachments = await prepareMessageAttachments(
		parsedChatId,
		msg,
		ctx.api,
		ctx.logger
	);

	await prisma.$transaction(async (tx) => {
		await tx.message.upsert({
			where: {
				messageId_chatId: {
					messageId: msg.message_id,
					chatId: parsedChatId,
				},
			},
			create: data,
			update: data,
		});

		await tx.attachment.deleteMany({
			where: {
				messageId: msg.message_id,
				chatId: parsedChatId,
			},
		});

		if (attachments.length > 0) {
			await tx.attachment.createMany({
				data: attachments.map((attachment) => ({
					messageId: msg.message_id,
					chatId: parsedChatId,
					attachmentType: attachment.attachmentType,
					mimeType: attachment.mimeType,
					s3Path: attachment.s3Path,
				})),
			});
		}
	});
}

export async function storeMessage(ctx: Context, next: NextFunction) {
	if (!(ctx.chat && ctx.message) || ctx.chat.type === "private") {
		return await next();
	}

	const msg = ctx.message;

	await upsertStoredMessage(ctx, msg);

	const repliedMessage = msg.reply_to_message;
	if (repliedMessage) {
		const sender = await syncUserFromMessage(repliedMessage);
		if (sender?.isBot) {
			await upsertStoredMessage(ctx, repliedMessage);
		}
	}

	ctx.logger.debug(
		{ messageId: msg.message_id, chatId: ctx.chat.id },
		"Stored chat message"
	);

	await next();
}

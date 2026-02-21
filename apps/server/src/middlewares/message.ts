import { prisma } from "@starlight/utils";
import type { NextFunction } from "grammy";
import type { Message } from "grammy/types";
import type { Context } from "@/types";

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

export default async function storeMessage(ctx: Context, next: NextFunction) {
	if (!(ctx.chat && ctx.message)) {
		return await next();
	}

	const msg = ctx.message;

	await prisma.message.create({
		data: {
			messageId: msg.message_id,
			chatId: BigInt(ctx.chat.id),
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
		},
	});

	ctx.logger.debug(
		{ messageId: msg.message_id, chatId: ctx.chat.id },
		"Stored chat message"
	);

	await next();
}

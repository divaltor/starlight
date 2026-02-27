import type { Attachment as PrismaAttachment } from "@starlight/utils";
import type { Message } from "grammy/types";
import sharp from "sharp";
import { logger } from "@/logger";
import { s3 } from "@/storage";
import type { Context } from "@/types";

const MAX_VIDEO_DOWNLOAD_SIZE = 20 * 1024 * 1024;

const MIME_TYPE_EXTENSION: Record<string, string> = {
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/ogg": "ogg",
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"video/mp4": "mp4",
	"video/quicktime": "mov",
	"video/webm": "webm",
};

// Attachment downloaded from Telegram, but not saved to database and S3 yet
interface PreparedAttachment {
	attachmentType: string;
	extension: string;
	mimeType: string;
	payload: Uint8Array;
}

// Attachment from database
export interface SavedAttachment extends Pick<
	PrismaAttachment,
	"attachmentType" | "mimeType" | "s3Path"
> {
	base64Data: string;
	summary: null; // Summary is null because we generate it on demand via queue and it's not ready yet usually on immediate acces
}

function extensionFromMimeType(mimeType: string, fallback: string): string {
	if (MIME_TYPE_EXTENSION[mimeType]) {
		return MIME_TYPE_EXTENSION[mimeType];
	}

	const [, subtype] = mimeType.split("/");
	return subtype!.split(";")[0]?.split("+")[0] || fallback;
}

async function downloadFilePayload(api: Context["api"], fileId: string): Promise<Uint8Array> {
	const file = await api.getFile(fileId);
	const path = await file.download();

	return await Bun.file(path).bytes();
}

async function convertImage(
	payload: Uint8Array,
	format: "jpeg" | "webp",
	quality: number,
): Promise<Uint8Array> {
	const pipeline = sharp(payload).rotate();
	return format === "jpeg"
		? await pipeline.jpeg({ quality }).toBuffer()
		: await pipeline.webp({ quality }).toBuffer();
}

async function preparePhotoAttachment(
	msg: Message,
	api: Context["api"],
): Promise<PreparedAttachment | null> {
	if (!(msg.photo && msg.photo.length > 0)) {
		return null;
	}

	// biome-ignore lint/style/noNonNullAssertion: photo.length > 0 guarantees .at(-1) is defined
	const largestPhoto = msg.photo.at(-1)!;
	const payload = await downloadFilePayload(api, largestPhoto.file_id);
	const converted = await convertImage(payload, "jpeg", 90);

	return {
		attachmentType: "photo",
		mimeType: "image/jpeg",
		extension: "jpg",
		payload: converted,
	};
}

async function prepareStickerAttachment(
	msg: Message,
	api: Context["api"],
): Promise<PreparedAttachment | null> {
	if (!msg.sticker) {
		return null;
	}

	const useThumbnail = msg.sticker.is_animated || msg.sticker.is_video;
	const sourceFileId = useThumbnail ? msg.sticker.thumbnail?.file_id : msg.sticker.file_id;

	if (!sourceFileId) {
		return null;
	}

	const payload = await downloadFilePayload(api, sourceFileId);
	const converted = await convertImage(payload, "webp", 90);

	return {
		attachmentType: "sticker",
		mimeType: "image/webp",
		extension: "webp",
		payload: converted,
	};
}

async function prepareVideoAttachment(
	msg: Message,
	api: Context["api"],
): Promise<PreparedAttachment | null> {
	if (!msg.video) {
		return null;
	}

	const isLargeVideo =
		typeof msg.video.file_size === "number" && msg.video.file_size > MAX_VIDEO_DOWNLOAD_SIZE;

	if (isLargeVideo) {
		if (!msg.video.thumbnail) {
			return null;
		}

		const payload = await downloadFilePayload(api, msg.video.thumbnail.file_id);
		const converted = await convertImage(payload, "jpeg", 90);

		return {
			attachmentType: "video_thumbnail",
			mimeType: "image/jpeg",
			extension: "jpg",
			payload: converted,
		};
	}

	const mimeType = msg.video.mime_type ?? "video/webm";
	const payload = await downloadFilePayload(api, msg.video.file_id);

	return {
		attachmentType: "video",
		mimeType,
		extension: extensionFromMimeType(mimeType, "webm"),
		payload,
	};
}

async function prepareAnimationAttachment(
	msg: Message,
	api: Context["api"],
): Promise<PreparedAttachment | null> {
	if (!msg.animation) {
		return null;
	}

	const mimeType = msg.animation.mime_type ?? "video/mp4";
	const payload = await downloadFilePayload(api, msg.animation.file_id);

	return {
		attachmentType: "animation",
		mimeType,
		extension: extensionFromMimeType(mimeType, "gif"),
		payload,
	};
}

async function prepareVideoNoteAttachment(
	msg: Message,
	api: Context["api"],
): Promise<PreparedAttachment | null> {
	if (!msg.video_note) {
		return null;
	}

	const payload = await downloadFilePayload(api, msg.video_note.file_id);

	return {
		attachmentType: "video_note",
		mimeType: "video/mp4",
		extension: "mp4",
		payload,
	};
}

async function prepareVoiceAttachment(
	msg: Message,
	api: Context["api"],
): Promise<PreparedAttachment | null> {
	if (!msg.voice) {
		return null;
	}

	const mimeType = msg.voice.mime_type ?? "audio/ogg";
	const payload = await downloadFilePayload(api, msg.voice.file_id);

	return {
		attachmentType: "voice",
		mimeType,
		extension: extensionFromMimeType(mimeType, "ogg"),
		payload,
	};
}

const handlers = [
	preparePhotoAttachment,
	prepareStickerAttachment,
	prepareVideoAttachment,
	prepareAnimationAttachment,
	prepareVideoNoteAttachment,
	prepareVoiceAttachment,
];

export class Attachment {
	static async save(ctx: Context, msg: Message): Promise<SavedAttachment[]> {
		logger.debug({ messageId: msg.message_id, chatId: ctx.chat!.id }, "Processing attachments");

		const preparedAttachments: PreparedAttachment[] = [];

		for (const handler of handlers) {
			try {
				const prepared = await handler(msg, ctx.api);
				if (prepared) {
					logger.debug(
						`Prepared ${prepared.attachmentType} (${prepared.mimeType}, ${prepared.payload.length} bytes)`,
					);
					preparedAttachments.push(prepared);
				}
			} catch (error) {
				ctx.logger.warn(
					{ error, messageId: msg.message_id, chatId: ctx.chat!.id },
					"Failed to prepare message attachment",
				);
			}
		}

		const savedAttachments = await Promise.all(
			preparedAttachments.map(async (attachment, index) => {
				const s3Path = `attachments/${ctx.chat!.id}/${msg.message_id}-${index}.${attachment.extension}`;
				const base64Data = Buffer.from(attachment.payload).toString("base64");

				await s3.write(s3Path, attachment.payload, { type: attachment.mimeType });

				logger.debug(`Saved ${attachment.attachmentType} to S3: ${s3Path}`);

				return {
					attachmentType: attachment.attachmentType,
					base64Data,
					mimeType: attachment.mimeType,
					s3Path,
					summary: null,
				} satisfies SavedAttachment;
			}),
		);

		logger.debug(`Saved ${savedAttachments.length} attachments`);

		return savedAttachments;
	}
}

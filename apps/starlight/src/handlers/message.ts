import { Composer } from "grammy";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { Duration, Effect, Schedule } from "effect";
import { Conversation } from "@/conversation/conversation";
import { Prompt } from "@/context/prompt";
import { Media } from "@/media/media";
import { runtime } from "@/services/runtime";

// 5 retries after the initial attempt; exponential delays 500ms → 8s.
const ADMISSION_RETRIES = 5;

export interface MessageHandlerOptions {
  readonly whitelistedChatIds: readonly number[];
  readonly whitelistedDmUserIds: readonly number[];
}

export function createMessageHandler(options: MessageHandlerOptions): Composer<Context> {
  const composer = new Composer<Context>();
  const chatWhitelist = new Set(options.whitelistedChatIds);
  const dmWhitelist = new Set(options.whitelistedDmUserIds);
  const groupChat = composer.chatType(["group", "supergroup"]).filter((ctx) => chatWhitelist.has(ctx.chat.id));
  const privateChat = composer.chatType("private");
  const authorizedPrivateChat = privateChat.filter((ctx) => dmWhitelist.has(ctx.from.id));
  const unauthorizedPrivateChat = privateChat.filter((ctx) => !dmWhitelist.has(ctx.from.id));

  groupChat
    .on("message")
    .filter(hasAdmittableContent)
    .use((ctx) => admitMessage(ctx, ctx.message, isAddressedToBot(ctx, ctx.message)));
  groupChat
    .on("edited_message")
    .filter(hasAdmittableEditedContent)
    .use((ctx) => admitMessage(ctx, ctx.editedMessage, isAddressedToBot(ctx, ctx.editedMessage)));
  authorizedPrivateChat
    .on("message")
    .filter(hasAdmittableContent)
    .use((ctx) => admitMessage(ctx, ctx.message, true));
  authorizedPrivateChat
    .on("edited_message")
    .filter(hasAdmittableEditedContent)
    .use((ctx) => admitMessage(ctx, ctx.editedMessage, true));
  unauthorizedPrivateChat
    .on("message")
    .filter(hasAdmittableContent)
    .use((ctx) => ctx.reply("Личные сообщения для этого аккаунта не разрешены."));

  return composer;
}

async function admitMessage(ctx: Context, message: Message, addressed: boolean) {
  await runtime.runPromise(
    // Telegram message variants are normalized once at admission.
    // oxlint-disable-next-line eslint/complexity
    Effect.gen(function* admit() {
      const conversation = yield* Conversation.Service;
      const media = yield* Media.Service;
      return yield* retryAdmission(
        // Telegram extraction is branch-heavy by protocol shape but remains one boundary normalization.
        // oxlint-disable-next-line eslint/complexity
        Effect.gen(function* attempt() {
          const references = yield* Effect.all(mediaSources(message).map(media.ingest), {
            concurrency: "unbounded",
          }).pipe(Effect.mapError(mediaAdmissionError));
          const repliedMedia = yield* Effect.all(mediaSources(message.reply_to_message).map(media.ingest), {
            concurrency: "unbounded",
          }).pipe(Effect.mapError(mediaAdmissionError));
          return yield* conversation.admit({
            chatTitle: ctx.chat!.title ?? null,
            chatUsername: ctx.chat!.username ?? null,
            key: {
              assistantId: ctx.me.id,
              chatId: ctx.chat!.id,
              threadKey: message.message_thread_id ?? 0,
            },
            payload: {
              addressed,
              date: message.date,
              editDate: message.edit_date ?? null,
              forwardOrigin: message.forward_origin ? Prompt.canonicalEncode(message.forward_origin) : null,
              messageId: message.message_id,
              media: references,
              mediaGroupId: message.media_group_id ?? null,
              repliedText: message.reply_to_message?.text ?? message.reply_to_message?.caption ?? null,
              repliedMedia,
              replyToMessageId: message.reply_to_message?.message_id ?? null,
              senderFirstName: message.from?.first_name ?? message.sender_chat?.title ?? "unknown",
              senderId: message.from?.id ?? null,
              senderIsBot: message.from?.is_bot ?? false,
              senderLastName: message.from?.last_name ?? null,
              senderUsername: message.from?.username ?? null,
              text: message.text ?? message.caption ?? "",
            },
            updateId: ctx.update.update_id,
          });
        }),
        ctx.update.update_id,
      );
    }),
  );
}

function mediaAdmissionError(error: Media.MediaError): Conversation.AdmissionError {
  return new Conversation.AdmissionError({
    cause: error,
    message: error.message,
    retryable: error.retryable,
  });
}

function retryAdmission(
  admission: Effect.Effect<Conversation.AdmissionResult, Conversation.AdmissionError>,
  updateId: number,
): Effect.Effect<Conversation.AdmissionResult, Conversation.AdmissionError> {
  return admission.pipe(
    Effect.tapError((error) =>
      error.retryable
        ? Effect.logWarning("Conversation admission attempt failed").pipe(
            Effect.annotateLogs({ errorTag: error._tag, updateId }),
          )
        : Effect.void,
    ),
    Effect.retry({
      schedule: Schedule.exponential(Duration.millis(500)),
      times: ADMISSION_RETRIES,
      while: (error) => error.retryable,
    }),
  );
}

function isAddressedToBot(ctx: Context, message: Message): boolean {
  const text = message.text ?? message.caption ?? "";
  return (
    message.reply_to_message?.from?.id === ctx.me.id ||
    Boolean(ctx.me.username && text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`)) ||
    // \b is ASCII-only, so it never bounds Cyrillic words; use explicit letter lookarounds.
    /(?<![\p{L}\p{N}_])(?:старка|зв[её]здочка)(?![\p{L}\p{N}_])/iu.test(text)
  );
}

function hasAdmittableContent(ctx: Context): boolean {
  return Boolean(ctx.message && ((ctx.message.text ?? ctx.message.caption) || mediaSources(ctx.message).length > 0));
}

function hasAdmittableEditedContent(ctx: Context): boolean {
  return Boolean(
    ctx.editedMessage &&
    ((ctx.editedMessage.text ?? ctx.editedMessage.caption) || mediaSources(ctx.editedMessage).length > 0),
  );
}

function mediaSources(message: Message | undefined): Media.Source[] {
  if (!message) return [];
  if (message.photo?.length) {
    const photo = message.photo.at(-1)!;
    return [source("photo", photo.file_id, photo.file_unique_id, "image/jpeg", photo.file_size)];
  }
  if (message.sticker) {
    const file = message.sticker.is_animated || message.sticker.is_video ? message.sticker.thumbnail : message.sticker;
    return file ? [source("sticker", file.file_id, file.file_unique_id, "image/webp", file.file_size)] : [];
  }
  if (message.animation) {
    return [
      source(
        "animation",
        message.animation.file_id,
        message.animation.file_unique_id,
        message.animation.mime_type ?? "video/mp4",
        message.animation.file_size,
      ),
    ];
  }
  if (message.video) {
    return [
      source(
        "video",
        message.video.file_id,
        message.video.file_unique_id,
        message.video.mime_type ?? "video/mp4",
        message.video.file_size,
      ),
    ];
  }
  if (message.video_note) {
    return [
      source(
        "video-note",
        message.video_note.file_id,
        message.video_note.file_unique_id,
        "video/mp4",
        message.video_note.file_size,
      ),
    ];
  }
  if (message.voice) {
    return [
      source(
        "voice",
        message.voice.file_id,
        message.voice.file_unique_id,
        message.voice.mime_type ?? "audio/ogg",
        message.voice.file_size,
      ),
    ];
  }
  if (message.audio) {
    return [
      source(
        "audio",
        message.audio.file_id,
        message.audio.file_unique_id,
        message.audio.mime_type ?? "audio/mpeg",
        message.audio.file_size,
      ),
    ];
  }
  if (message.document) {
    return [
      source(
        "document",
        message.document.file_id,
        message.document.file_unique_id,
        message.document.mime_type ?? "application/octet-stream",
        message.document.file_size,
      ),
    ];
  }
  return [];
}

function source(
  type: Media.Type,
  telegramFileId: string,
  telegramFileUniqueId: string,
  mimeType: string,
  declaredSize: number | undefined,
): Media.Source {
  return { declaredSize: declaredSize ?? null, mimeType, telegramFileId, telegramFileUniqueId, type };
}

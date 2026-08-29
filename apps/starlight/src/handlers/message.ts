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

const composer = new Composer<Context>();
const groupChat = composer.chatType(["group", "supergroup"]);
const privateChat = composer.chatType("private");

groupChat
  .on("message")
  .filter(hasAdmittableContent)
  .use((ctx) => admitMessage(ctx, ctx.message, isAddressedToBot(ctx, ctx.message)));
groupChat
  .on("edited_message")
  .filter(hasAdmittableEditedContent)
  .use((ctx) => admitMessage(ctx, ctx.editedMessage, false));
privateChat
  .on("message")
  .filter(hasAdmittableContent)
  .use((ctx) => admitMessage(ctx, ctx.message, true));
privateChat
  .on("edited_message")
  .filter(hasAdmittableEditedContent)
  .use((ctx) => admitMessage(ctx, ctx.editedMessage, false));

export default composer;

async function admitMessage(ctx: Context, message: Message, addressed: boolean) {
  await runtime.runPromise(
    // Telegram message variants are normalized once at admission.
    // oxlint-disable-next-line eslint/complexity
    Effect.gen(function* admit() {
      const conversation = yield* Conversation.Service;
      const media = yield* Media.Service;
      // Telegram extraction is branch-heavy by protocol shape but remains one boundary normalization.
      // oxlint-disable-next-line eslint/complexity
      return yield* Effect.gen(function* attempt() {
        const references = yield* Effect.all(Media.fromTelegramMessage(message).map(media.ingest), {
          concurrency: "unbounded",
        }).pipe(Effect.mapError(mediaAdmissionError));
        const repliedMedia = yield* Effect.all(Media.fromTelegramMessage(message.reply_to_message).map(media.ingest), {
          concurrency: "unbounded",
        }).pipe(Effect.mapError(mediaAdmissionError));
        return yield* conversation.admit({
          chatTitle: ctx.chat!.title ?? null,
          chatType: ctx.chat!.type,
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
      }).pipe(
        Effect.tapError((error) =>
          error.retryable
            ? Effect.logWarning("Conversation admission attempt failed").pipe(
                Effect.annotateLogs({ errorTag: error._tag, updateId: ctx.update.update_id }),
              )
            : Effect.void,
        ),
        Effect.retry({
          schedule: Schedule.exponential(Duration.millis(500)),
          times: ADMISSION_RETRIES,
          while: (error) => error.retryable,
        }),
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
  return Boolean(
    ctx.message && ((ctx.message.text ?? ctx.message.caption) || Media.fromTelegramMessage(ctx.message).length > 0),
  );
}

function hasAdmittableEditedContent(ctx: Context): boolean {
  return Boolean(
    ctx.editedMessage &&
    ((ctx.editedMessage.text ?? ctx.editedMessage.caption) || Media.fromTelegramMessage(ctx.editedMessage).length > 0),
  );
}

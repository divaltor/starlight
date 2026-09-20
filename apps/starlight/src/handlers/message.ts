import { Composer } from "grammy";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { Duration, Effect, Schedule } from "effect";
import { DialogueContinuation } from "@/ai/dialogue-continuation";
import { Conversation } from "@/conversation/conversation";
import { Prompt } from "@/context/prompt";
import { createBotEnv } from "@/env";
import { MessageReply } from "@/handlers/message-reply";
import { TelegramMessageText } from "@/handlers/telegram-message-text";
import { Media } from "@/media/media";
import { runtime } from "@/services/runtime";

// 5 retries after the initial attempt; exponential delays 500ms → 8s.
const ADMISSION_RETRIES = 5;
const randomResponseChance = createBotEnv().RANDOM_RESPONSE_CHANCE;

const composer = new Composer<Context>();
const groupChat = composer.chatType(["group", "supergroup"]);
const privateChat = composer.chatType("private");

groupChat
  .on("message")
  .filter(hasAdmittableContent)
  .use((ctx) => {
    const explicitlyAddressed = MessageReply.isAddressedToBot({
      botId: ctx.me.id,
      botUsername: ctx.me.username,
      message: ctx.message,
    });
    const hasSticker = ctx.message.sticker !== undefined;
    const replyTo = MessageReply.actualReply(ctx.message);
    const responded = MessageReply.shouldRespond({
      explicitlyAddressed,
      hasSticker,
      isReply: replyTo !== undefined,
      random: Math.random,
      randomResponseChance,
      text: ctx.message.text ?? ctx.message.caption ?? "",
    });
    const continuationCandidate = !responded && !hasSticker;
    const evaluateContinuation =
      continuationCandidate && replyTo === undefined && (ctx.message.text ?? ctx.message.caption) !== undefined;
    return admitMessage(
      ctx,
      ctx.message,
      responded,
      responded && !explicitlyAddressed && !hasSticker,
      evaluateContinuation,
    );
  });
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

async function admitMessage(
  ctx: Context,
  message: Message,
  addressed: boolean,
  randomResponseTriggered = false,
  evaluateContinuation = false,
) {
  await runtime.runPromise(
    // Telegram message variants are normalized once at admission.
    // oxlint-disable-next-line eslint/complexity
    Effect.gen(function* admit() {
      const conversation = yield* Conversation.Service;
      const dialogueContinuation = yield* DialogueContinuation.Service;
      const media = yield* Media.Service;
      const threadKey = message.is_topic_message === true ? (message.message_thread_id ?? 0) : 0;
      const continuation = evaluateContinuation
        ? yield* dialogueContinuation
            .evaluate({
              key: { assistantId: ctx.me.id, chatId: ctx.chat!.id, threadKey },
              messageId: message.message_id,
              senderFirstName: message.from?.first_name ?? message.sender_chat?.title ?? "unknown",
              senderId: message.from?.id ?? null,
              text: TelegramMessageText.withEntityLinks(message) ?? "",
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Dialogue continuation evaluation failed").pipe(
                  Effect.annotateLogs({
                    chatId: ctx.chat!.id,
                    errorTag: error._tag,
                    messageId: message.message_id,
                    threadKey,
                  }),
                  Effect.as({ type: "silence" } as const),
                ),
              ),
            )
        : ({ type: "silence" } as const);
      if (randomResponseTriggered) {
        yield* Effect.logInfo("Random response chance triggered").pipe(
          Effect.annotateLogs({
            chatId: ctx.chat!.id,
            messageId: message.message_id,
            randomResponseChance,
            senderId: message.from?.id ?? null,
          }),
        );
      }
      // Telegram extraction is branch-heavy by protocol shape but remains one boundary normalization.
      // oxlint-disable-next-line eslint/complexity
      return yield* Effect.gen(function* attempt() {
        const replyTo = MessageReply.actualReply(message);
        const references = yield* Effect.all(Media.fromTelegramMessage(message).map(media.ingest), {
          concurrency: "unbounded",
        }).pipe(Effect.mapError(mediaAdmissionError));
        const repliedMedia = yield* Effect.all(Media.fromTelegramMessage(replyTo).map(media.ingest), {
          concurrency: "unbounded",
        }).pipe(Effect.mapError(mediaAdmissionError));
        return yield* conversation.admit({
          chatTitle: ctx.chat!.title ?? null,
          chatType: ctx.chat!.type,
          chatUsername: ctx.chat!.username ?? null,
          key: {
            assistantId: ctx.me.id,
            chatId: ctx.chat!.id,
            // Only forum topics open a distinct lane; ordinary reply threads stay in the chat lane.
            threadKey,
          },
          payload: {
            addressed: addressed || continuation.type !== "silence",
            date: message.date,
            editDate: message.edit_date ?? null,
            forwardOrigin: message.forward_origin ? Prompt.canonicalEncode(message.forward_origin) : null,
            messageId: message.message_id,
            media: references,
            mediaGroupId: message.media_group_id ?? null,
            precomputedReaction:
              continuation.type === "reaction"
                ? { emoji: continuation.emoji, messageId: message.message_id }
                : undefined,
            repliedText: TelegramMessageText.withEntityLinks(replyTo),
            repliedMedia,
            replyToMessageId: replyTo?.message_id ?? null,
            senderFirstName: message.from?.first_name ?? message.sender_chat?.title ?? "unknown",
            senderId: message.from?.id ?? null,
            senderIsBot: message.from?.is_bot ?? false,
            senderLastName: message.from?.last_name ?? null,
            senderUsername: message.from?.username ?? null,
            text: TelegramMessageText.withEntityLinks(message) ?? "",
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

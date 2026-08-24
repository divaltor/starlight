import { Composer } from "grammy";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { Duration, Effect, Schedule } from "effect";
import { Conversation } from "@/conversation/conversation";
import { Prompt } from "@/context/prompt";
import { runtime } from "@/services/runtime";

// 5 retries after the initial attempt; exponential delays 500ms → 8s.
const ADMISSION_RETRIES = 5;
const TEXT_MESSAGE = "message:text" as const;

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

  groupChat.on(TEXT_MESSAGE, (ctx) => admitMessage(ctx, ctx.message, isAddressedToBot(ctx, ctx.message)));
  groupChat.on("edited_message:text", (ctx) =>
    admitMessage(ctx, ctx.editedMessage, isAddressedToBot(ctx, ctx.editedMessage)),
  );
  authorizedPrivateChat.on(TEXT_MESSAGE, (ctx) => admitMessage(ctx, ctx.message, true));
  authorizedPrivateChat.on("edited_message:text", (ctx) => admitMessage(ctx, ctx.editedMessage, true));
  unauthorizedPrivateChat.on(TEXT_MESSAGE, (ctx) => ctx.reply("Личные сообщения для этого аккаунта не разрешены."));

  return composer;
}

async function admitMessage(ctx: Context, message: Message.TextMessage, addressed: boolean) {
  await runtime.runPromise(
    // Telegram message variants are normalized once at admission.
    // oxlint-disable-next-line eslint/complexity
    Effect.gen(function* admit() {
      const conversation = yield* Conversation.Service;
      return yield* retryAdmission(
        conversation.admit({
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
            repliedText: message.reply_to_message?.text ?? message.reply_to_message?.caption ?? null,
            replyToMessageId: message.reply_to_message?.message_id ?? null,
            senderFirstName: message.from?.first_name ?? message.sender_chat?.title ?? "unknown",
            senderId: message.from?.id ?? null,
            senderIsBot: message.from?.is_bot ?? false,
            senderLastName: message.from?.last_name ?? null,
            senderUsername: message.from?.username ?? null,
            text: message.text,
          },
          updateId: ctx.update.update_id,
        }),
        ctx.update.update_id,
      );
    }),
  );
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

function isAddressedToBot(ctx: Context, message: Message.TextMessage): boolean {
  return (
    message.reply_to_message?.from?.id === ctx.me.id ||
    Boolean(ctx.me.username && message.text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`)) ||
    // \b is ASCII-only, so it never bounds Cyrillic words; use explicit letter lookarounds.
    /(?<![\p{L}\p{N}_])(?:старка|зв[её]здочка)(?![\p{L}\p{N}_])/iu.test(message.text)
  );
}

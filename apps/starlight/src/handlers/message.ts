import { Composer } from "grammy";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { Duration, Effect, Schedule } from "effect";
import * as Conversation from "@/conversation/conversation";
import * as Prompt from "@/context/prompt";
import { runtime } from "@/services/runtime";

// 5 retries after the initial attempt; exponential delays 500ms → 8s.
const ADMISSION_RETRIES = 5;

export function createMessageHandler(whitelistedChatIds: readonly number[]): Composer<Context> {
	const composer = new Composer<Context>();
	const whitelist = new Set(whitelistedChatIds);
	const groupChat = composer
		.chatType(["group", "supergroup"])
		.filter((ctx) => whitelist.has(ctx.chat.id));

	groupChat.on("message:text", (ctx) =>
		admitMessage(ctx, ctx.message, isAddressedToBot(ctx, ctx.message)),
	);
	groupChat.on("edited_message:text", (ctx) =>
		admitMessage(ctx, ctx.editedMessage, isAddressedToBot(ctx, ctx.editedMessage)),
	);

	return composer;
}

async function admitMessage(ctx: Context, message: Message.TextMessage, addressed: boolean) {
	await runtime.runPromise(
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
						forwardOrigin: message.forward_origin
							? Prompt.canonicalEncode(message.forward_origin)
							: null,
						messageId: message.message_id,
						repliedText:
							message.reply_to_message?.text ?? message.reply_to_message?.caption ?? null,
						replyToMessageId: message.reply_to_message?.message_id ?? null,
						senderFirstName: message.from?.first_name ?? message.sender_chat?.title ?? "unknown",
						senderId: message.from?.id ?? null,
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
		Boolean(
			ctx.me.username && message.text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`),
		) ||
		// \b is ASCII-only, so it never bounds Cyrillic words; use explicit letter lookarounds.
		/(?<![\p{L}\p{N}_])(?:старка|зв[её]здочка)(?![\p{L}\p{N}_])/iu.test(message.text)
	);
}

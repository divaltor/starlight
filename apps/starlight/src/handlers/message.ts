import { Effect } from "effect";
import { Composer } from "grammy";
import type { Context } from "grammy";
import * as ChatReply from "@/ai/chat-reply";
import type * as Model from "@/ai/model";
import { extractAllowedUrls } from "@/ai/tools/web";
import { runtime } from "@/services/runtime";

export function createMessageHandler(
	affinitySecret: string,
	whitelistedChatIds: readonly number[],
): Composer<Context> {
	const composer = new Composer<Context>();
	const whitelist = new Set(whitelistedChatIds);
	const privateChat = composer.chatType("private").filter((ctx) => whitelist.has(ctx.chat.id));
	const groupChat = composer
		.chatType(["group", "supergroup"])
		.filter((ctx) => whitelist.has(ctx.chat.id));
	const affinityKey = crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(affinitySecret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);

	privateChat.on("message:text", (ctx) => handleMessage(ctx, affinityKey));
	groupChat
		.on("message:text")
		.filter((ctx) => isAddressedToBot(ctx))
		.use((ctx) => handleMessage(ctx, affinityKey));

	return composer;
}

async function handleMessage(ctx: Context, affinityKey: Promise<CryptoKey>): Promise<void> {
	const generated = await runtime.runPromise(
		ChatReply.generate({
			allowedUrls: extractAllowedUrls(ctx.message!.text!),
			messages: createMessages(ctx),
			sessionId: await createAffinityId(ctx, affinityKey),
		}).pipe(
			Effect.catch((error) =>
				Effect.logError("Chat reply failed").pipe(
					Effect.annotateLogs({ errorTag: error._tag, retryable: error.retryable }),
					Effect.as(null),
				),
			),
			Effect.annotateLogs({ updateId: ctx.update.update_id }),
		),
	);

	await (generated ? dispatchActions(ctx, generated.output) : Promise.resolve());
}

function createMessages(ctx: Context): Model.Message[] {
	const message = ctx.message!;
	const sender = message.from?.first_name ?? message.sender_chat?.title ?? "unknown";
	const repliedText = message.reply_to_message?.text ?? message.reply_to_message?.caption;
	const previous = repliedText
		? `Previous message #${message.reply_to_message!.message_id}: ${repliedText}\n`
		: "";

	return [
		{
			role: "user",
			text: `${previous}Current date: ${new Date().toISOString().slice(0, 10)}\nLIVE MESSAGE #${message.message_id} from ${sender}: ${message.text!}`,
		},
	];
}

async function dispatchActions(ctx: Context, response: ChatReply.Response): Promise<void> {
	await Promise.all(response.replies.map((action) => dispatchAction(ctx, action)));
}

function dispatchAction(
	ctx: Context,
	action: ChatReply.Response["replies"][number],
): Promise<void> {
	if (action.type === "ignore") return Promise.resolve();
	if (action.type === "reaction") return sendReaction(ctx, action);
	return sendText(ctx, action);
}

async function sendReaction(
	ctx: Context,
	action: Extract<ChatReply.Response["replies"][number], { type: "reaction" }>,
): Promise<void> {
	if (!allowedTargetIds(ctx).has(action.messageId)) return;

	await ctx.api.setMessageReaction(ctx.chat!.id, action.messageId, [
		{ emoji: action.emoji, type: "emoji" },
	]);
}

async function sendText(
	ctx: Context,
	action: Extract<ChatReply.Response["replies"][number], { type: "text" }>,
): Promise<void> {
	if (action.replyTo && !allowedTargetIds(ctx).has(action.replyTo)) return;

	await ctx.reply(action.text, {
		message_thread_id: ctx.message!.message_thread_id,
		reply_parameters: action.replyTo ? { message_id: action.replyTo } : undefined,
	});
}

function allowedTargetIds(ctx: Context): ReadonlySet<number> {
	return new Set([
		ctx.message!.message_id,
		...(ctx.message!.reply_to_message ? [ctx.message!.reply_to_message.message_id] : []),
	]);
}

function isAddressedToBot(ctx: Context): boolean {
	const text = ctx.message!.text!;
	return (
		ctx.message!.reply_to_message?.from?.id === ctx.me.id ||
		Boolean(ctx.me.username && text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`)) ||
		/\b(?:старка|зв[её]здочка)\b/iu.test(text)
	);
}

async function createAffinityId(ctx: Context, key: Promise<CryptoKey>): Promise<string> {
	const thread = ctx.message!.message_thread_id ?? "main";
	const signature = await crypto.subtle.sign(
		"HMAC",
		await key,
		new TextEncoder().encode(`${ctx.chat!.id}:${thread}`),
	);

	return Buffer.from(signature).toString("hex").slice(0, 32);
}

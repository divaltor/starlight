import { trace } from "@opentelemetry/api";
import { Effect } from "effect";
import type { Context, MiddlewareFn } from "grammy";
import { Database } from "@/services/database";
import { runtime } from "@/services/runtime";

const premiumAccess: MiddlewareFn<Context> = async (ctx, next) => {
  if (!ctx.chat) return;

  // Guest chat IDs belong to an independent chat; premium access belongs to the sender's regular DM chat.
  const chatId = ctx.guestMessage ? ctx.from!.id : ctx.chat.id;

  const chat = await runtime.runPromise(
    Effect.gen(function* verifyChatAccess() {
      const database = yield* Database.Service;
      return yield* database.query((client) =>
        client.chat.findUnique({ where: { id: BigInt(chatId) }, select: { isPremium: true, isPrivate: true } }),
      );
    }),
  );

  // Langfuse groups traces into sessions by langfuse.session.id; one session per
  // conversation lane (chat + topic thread). Session and user ids are numeric Telegram
  // ids — pseudonymous, no PII — so costs stay attributable per chat/session even for
  // private chats. Only the display name is withheld there.
  const span = trace.getActiveSpan();
  if (span !== undefined) {
    const chatName = ctx.chat.title ?? ctx.chat.first_name;
    const attributes: Record<string, string> = {
      "langfuse.session.id": `${chatId}/${ctx.msg?.message_thread_id ?? 0}`,
      ...(ctx.from !== undefined && { "langfuse.user.id": ctx.from.id.toString() }),
    };
    if (chat?.isPrivate === true) {
      attributes["starlight.private"] = "true";
    } else if (chatName !== undefined) {
      attributes["langfuse.trace.name"] = chatName;
    }
    span.setAttributes(attributes);
  }

  if (chat?.isPremium) {
    await next();
    return;
  }

  if (ctx.chat.type === "private" && ctx.message) {
    await ctx.reply("Личные сообщения для этого аккаунта не разрешены.");
  }
};

export default premiumAccess;

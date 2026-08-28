import { Effect } from "effect";
import { Composer } from "grammy";
import type { Context } from "grammy";
import { GuestReply } from "@/ai/guest-reply";
import { runtime } from "@/services/runtime";

const composer = new Composer<Context>();

composer.on("guest_message:text", async (ctx) => {
  const text = await runtime.runPromise(
    Effect.gen(function* generateGuestReply() {
      const guestReply = yield* GuestReply.Service;
      return yield* guestReply.generate({
        message: ctx.guestMessage!.text,
        sessionId: `guest:${ctx.from!.id}:${ctx.update.update_id}`,
      });
    }),
  );

  await ctx.api.answerGuestQuery(ctx.guestMessage!.guest_query_id!, {
    type: "article",
    id: crypto.randomUUID(),
    title: "Ответ Старки",
    input_message_content: { message_text: text },
  });
});

export default composer;

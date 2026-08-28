import { Effect } from "effect";
import { Composer } from "grammy";
import type { Context } from "grammy";
import { GuestReply } from "@/ai/guest-reply";
import { Media } from "@/media/media";
import { runtime } from "@/services/runtime";

const composer = new Composer<Context>();

composer.on("guest_message:text", async (ctx) => {
  const text = await runtime.runPromise(
    Effect.gen(function* generateGuestReply() {
      const guestReply = yield* GuestReply.Service;
      const media = yield* Media.Service;
      const repliedMedia = yield* Effect.all(
        Media.fromTelegramMessage(ctx.guestMessage!.reply_to_message).map((source) =>
          media.ingest(source).pipe(Effect.flatMap(media.load)),
        ),
        { concurrency: "unbounded" },
      );
      return yield* guestReply.generate({
        message: ctx.guestMessage!.text,
        repliedMedia: repliedMedia.filter((item): item is Media.Loaded => item !== null),
        repliedMessage: ctx.guestMessage!.reply_to_message?.text ?? ctx.guestMessage!.reply_to_message?.caption ?? null,
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

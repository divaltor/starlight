import { Effect } from "effect";
import { Composer } from "grammy";
import type { Context } from "grammy";
import { TopicMetadata } from "@/ai/topic-metadata";
import { runtime } from "@/services/runtime";

const composer = new Composer<Context>();
// fork() runs metadata generation concurrently with the rest of the update
// chain (message admission) while keeping the work inside the update's
// lifetime, so failures still reach the error boundary.
const privateChat = composer.fork().chatType("private");

privateChat.on("message:forum_topic_created", async (ctx) => {
  const stickers = await ctx.api.getForumTopicIconStickers();
  const icons = stickers.flatMap((sticker) =>
    sticker.custom_emoji_id ? [{ customEmojiId: sticker.custom_emoji_id, emoji: sticker.emoji ?? "custom emoji" }] : [],
  );
  if (icons.length === 0) throw new Error("Telegram returned no forum topic icons");

  const metadata = await runtime.runPromise(
    Effect.gen(function* generateTopicMetadata() {
      const topicMetadata = yield* TopicMetadata.Service;
      return yield* topicMetadata.generate({
        icons,
        initialName: ctx.msg!.forum_topic_created.name,
        isNameImplicit: ctx.msg!.forum_topic_created.is_name_implicit === true,
        sessionId: `${ctx.chat!.id}/${ctx.msg!.message_thread_id!}`,
        userId: ctx.from!.id.toString(),
      });
    }),
  );

  await ctx.api.editForumTopic(ctx.chat!.id, ctx.msg!.message_thread_id!, {
    icon_custom_emoji_id: metadata.iconCustomEmojiId,
    name: metadata.name,
  });

  await runtime.runPromise(
    Effect.logInfo("New Telegram topic metadata generated").pipe(
      Effect.annotateLogs({ chatId: ctx.chat!.id, messageThreadId: ctx.msg!.message_thread_id }),
    ),
  );
});

export default composer;

import { Effect } from "effect";
import { Composer } from "grammy";
import type { Context } from "grammy";
import { Media } from "@/media/media";
import { Database } from "@/services/database";
import { runtime } from "@/services/runtime";

const composer = new Composer<Context>();
const groupChat = composer.chatType(["group", "supergroup"]);

groupChat
  .on("my_chat_member")
  .filter((ctx) => !["left", "kicked"].includes(ctx.myChatMember.new_chat_member.status))
  .use(async (ctx) => {
    await runtime.runPromise(
      Effect.gen(function* registerGroupChat() {
        const database = yield* Database.Service;
        const media = yield* Media.Service;
        const chatInfo = yield* Effect.tryPromise(() => ctx.api.getChat(ctx.chat.id)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to load group chat details").pipe(
              Effect.annotateLogs({ chatId: ctx.chat.id, error: String(error) }),
              Effect.as(null),
            ),
          ),
        );
        const photos = chatInfo?.photo
          ? yield* Effect.all(
              {
                big: media.ingest({
                  declaredSize: null,
                  mimeType: "image/jpeg",
                  telegramFileId: chatInfo.photo.big_file_id,
                  telegramFileUniqueId: chatInfo.photo.big_file_unique_id,
                  type: "photo",
                }),
                thumbnail: media.ingest({
                  declaredSize: null,
                  mimeType: "image/jpeg",
                  telegramFileId: chatInfo.photo.small_file_id,
                  telegramFileUniqueId: chatInfo.photo.small_file_unique_id,
                  type: "photo",
                }),
              },
              { concurrency: "unbounded" },
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Failed to store group chat photos").pipe(
                  Effect.annotateLogs({ chatId: ctx.chat.id, errorTag: error._tag }),
                  Effect.as(null),
                ),
              ),
            )
          : null;
        const photoBig = photos?.big.availability === "stored" ? photos.big.s3Key : undefined;
        const photoThumbnail = photos?.thumbnail.availability === "stored" ? photos.thumbnail.s3Key : undefined;
        yield* database.query((client) =>
          client.chat.upsert({
            where: { id: BigInt(ctx.chat.id) },
            create: {
              id: BigInt(ctx.chat.id),
              isPrivate: false,
              ...(photoBig !== undefined && { photoBig }),
              ...(photoThumbnail !== undefined && { photoThumbnail }),
              title: ctx.chat.title,
              username: ctx.chat.username,
            },
            update: {
              isPrivate: false,
              ...(photoBig !== undefined && { photoBig }),
              ...(photoThumbnail !== undefined && { photoThumbnail }),
              title: ctx.chat.title,
              username: ctx.chat.username,
            },
          }),
        );
      }),
    );
  });

export default composer;

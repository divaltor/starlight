import type { FileFlavor } from "@grammyjs/files";
import type { Message, MessageEntity, MessageOrigin } from "@grammyjs/types";
import type { Chat, ChatMember, User } from "@starlight/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Schema } from "effect";
import type { Context as BaseContext } from "grammy";
import type { Logger } from "@/logger";

interface ExtendedContext {
  logger: Logger;
  user?: User;
  userChat?: Chat;
  userChatMember?: ChatMember;
  isSupervisor: boolean;
}

export const Classification = Schema.Struct({
  aesthetic: Schema.Number,
  characters: Schema.Array(Schema.String),
  nsfw: Schema.Struct({
    is_nsfw: Schema.Boolean,
    scores: Schema.Struct({
      neutral: Schema.Number,
      low: Schema.Number,
      medium: Schema.Number,
      high: Schema.Number,
    }),
  }),
  style: Schema.Struct({
    anime: Schema.Number,
    other: Schema.Number,
    third_dimension: Schema.Number,
    real_life: Schema.Number,
    manga_like: Schema.Number,
  }),
  tags: Schema.Array(Schema.String),
});
export type Classification = typeof Classification.Type;

export type Context = FileFlavor<BaseContext & ExtendedContext>;

declare global {
  // biome-ignore lint/style/noNamespace: Prisma
  namespace PrismaJson {
    type TweetType = Tweet;
    type ClassificationType = typeof Classification.Type;
    type MessageEntitiesType = MessageEntity[];
    type ForwardOriginType = MessageOrigin;
    type TelegramMessageType = Message;
  }
}

import type { FileFlavor } from "@grammyjs/files";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Message, MessageOrigin, MessageEntity } from "@grammyjs/types";
import type { Chat, User } from "@starlight/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import type { Context as BaseContext, SessionFlavor } from "grammy";
import type { Logger } from "@/logger";
import type { SessionData } from "@/storage";

interface ExtendedContext {
	logger: Logger;
	user?: User;
	userChat?: Chat;
}

export interface Classification {
	aesthetic: number;
	nsfw: {
		is_nsfw: boolean;
		scores: {
			neutral: number;
			low: number;
			medium: number;
			high: number;
		};
	};
	style: {
		anime: number;
		other: number;
		third_dimension: number;
		real_life: number;
		manga_like: number;
	};
	tags: string[];
}

export type Context = FileFlavor<
	HydrateFlavor<BaseContext & ExtendedContext & SessionFlavor<SessionData>>
>;

declare global {
	// biome-ignore lint/style/noNamespace: Prisma
	namespace PrismaJson {
		type TweetType = Tweet;
		type ClassificationType = Classification;
		type MessageEntitiesType = MessageEntity[];
		type ForwardOriginType = MessageOrigin;
		type TelegramMessageType = Message;
	}
}

import type { FileFlavor } from "@grammyjs/files";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Message, MessageEntity, MessageOrigin } from "@grammyjs/types";
import type { Chat, ChatMember, User } from "@starlight/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import type { Context as BaseContext, SessionFlavor } from "grammy";
import type { Logger } from "@/logger";
import type { SessionData } from "@/storage";

interface ExtendedContext {
	logger: Logger;
	user?: User;
	userChat?: Chat;
	userChatMember?: ChatMember;
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

export interface ChatSettings {
	botAliases: string[];
	botName: string | null;
	ignoreUserChance: number;
	inferenceUnavailableAliases: string[];
	personalityTraits: string[];
	randomResponseChance: number;
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
		type ChatSettingsType = ChatSettings;
	}
}

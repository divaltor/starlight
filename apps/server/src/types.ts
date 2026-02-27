import type { FileFlavor } from "@grammyjs/files";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Message, MessageEntity, MessageOrigin } from "@grammyjs/types";
import type { Chat, ChatMember, User } from "@starlight/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import type { Context as BaseContext } from "grammy";
import type { Logger } from "@/logger";
import type { ChatMemorySettings } from "@/services/chat-memory";
import type { SavedAttachment } from "./utils/attachment";

interface ExtendedContext {
	chatSettings: ChatMemorySettings;
	attachments: SavedAttachment[];
	logger: Logger;
	user?: User;
	userChat?: Chat;
	userChatMember?: ChatMember;
	isSupervisor: boolean;
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
	botAliases?: string[];
	botName?: string | null;
	ignoreUserChance?: number;
	inferenceUnavailableAliases?: string[];
	memory?: {
		enabled?: boolean;
		globalEveryMessages?: number;
		topicEveryMessages?: number;
	};
	personalityTraits?: string[];
	randomResponseChance?: number;
}

export type Context = FileFlavor<HydrateFlavor<BaseContext & ExtendedContext>>;

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

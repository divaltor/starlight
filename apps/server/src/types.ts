import type { FileFlavor } from "@grammyjs/files";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Chat, User } from "@prisma/client";
import type { Tweet } from "@the-convocation/twitter-scraper";
import type { Context as BaseContext, SessionFlavor } from "grammy";
import type { Logger } from "@/logger";
import type { SessionData } from "@/storage";

type ExtendedContext = {
	logger: Logger;
	user?: User;
	userChat?: Chat;
};

export type Classification = {
	aesthetic: number;
	style: {
		anime: number;
		other: number;
		third_dimension: number;
		real_life: number;
		manga_like: number;
	};
	nsfw: number;
	tags: string[];
};

export type Context = FileFlavor<
	HydrateFlavor<BaseContext & ExtendedContext & SessionFlavor<SessionData>>
>;

declare global {
	// biome-ignore lint/style/noNamespace: Prisma
	namespace PrismaJson {
		type TweetType = Tweet;
		type ClassificationType = Classification;
	}
}

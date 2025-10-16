import type { FileFlavor } from "@grammyjs/files";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Chat, Logger, User } from "@starlight/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import type { Context as BaseContext, SessionFlavor } from "grammy";
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
	nsfw: {
		is_nsfw: boolean;
		scores: {
			neutral: number;
			low: number;
			medium: number;
			high: number;
		};
	};
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

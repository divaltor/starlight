import type { Logger } from "@/logger";
import type { SessionData } from "@/storage";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Chat, User } from "@prisma/client";
import type { Tweet } from "@the-convocation/twitter-scraper";
import type { Context as BaseContext } from "grammy";
import type { SessionFlavor } from "grammy";

interface ExtendedContext {
	logger: Logger;
	user?: User;
	userChat?: Chat;
}

export type Context = HydrateFlavor<
	BaseContext & ExtendedContext & SessionFlavor<SessionData>
>;

declare global {
	namespace PrismaJson {
		type TweetType = Tweet;
	}
}

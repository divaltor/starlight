import type { Logger } from "@/server/logger";
import type { SessionData } from "@/server/storage";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { User } from "@prisma/client";
import type { Tweet } from "@the-convocation/twitter-scraper";
import type { Context as BaseContext } from "grammy";
import type { SessionFlavor } from "grammy";

interface ExtendedContext {
	logger: Logger;
	user?: User;
}

export type Context = HydrateFlavor<
	BaseContext & ExtendedContext & SessionFlavor<SessionData>
>;

declare global {
	namespace PrismaJson {
		type TweetType = Tweet;
	}
}

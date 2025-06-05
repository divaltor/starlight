import type { Logger } from "@/logger";
import type { SessionData } from "@/storage";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Tweet, User } from "@prisma/client";
import type { Context as BaseContext } from "grammy";
import type { SessionFlavor } from "grammy";

interface ExtendedContext {
	logger: Logger;
	user?: User;
}

export type Context = HydrateFlavor<
	BaseContext & ExtendedContext & SessionFlavor<SessionData>
>;

export type UserContext = HydrateFlavor<Context & { user: User }>;

declare global {
	namespace PrismaJson {
		type TweetType = Tweet;
	}
}

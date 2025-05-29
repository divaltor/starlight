import {
	type Context as BaseContext,
	Bot,
	type SessionFlavor,
	session,
} from "grammy";

import env from "@/config";
import { type Logger, logger } from "@/logger";
import { type SessionData, redis } from "@/storage";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import { RedisAdapter } from "@grammyjs/storage-redis";

interface ExtendedContext {
	logger: Logger;
}

type Context = HydrateFlavor<
	BaseContext & ExtendedContext & SessionFlavor<SessionData>
>;

const bot = new Bot<Context>(env.BOT_TOKEN);

bot.use(
	session({
		type: "multi",
		user: {
			initial: () => ({ cookies: null }),
			storage: new RedisAdapter({ instance: redis }),
		},
	}),
);

bot.use(async (ctx, next) => {
	ctx.logger = logger.child({});

	await next();
});

export { bot, type Context };

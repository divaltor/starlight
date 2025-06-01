import { Bot, session } from "grammy";

import env from "@/config";
import type { Context } from "@/context";
import { logger } from "@/logger";
import logUpdates from "@/middlewares/logging";
import { redis } from "@/storage";
import { RedisAdapter } from "@grammyjs/storage-redis";


const bot = new Bot<Context>(env.BOT_TOKEN);

bot.use(
	session({
		type: "multi",
		cookies: {
			initial: () => null,
			prefix: "user-cookies-",
			storage: new RedisAdapter({ instance: redis }),
		},
	}),
);

bot.use(async (ctx, next) => {
	ctx.logger = logger.child({});

	await next();
});

bot.use(logUpdates);

export { bot, type Context };

import { Bot, session } from "grammy";

import env from "@/config";
import { logger } from "@/logger";
import logUpdates from "@/middlewares/logging";
import attachUser from "@/middlewares/session";
import { redis } from "@/storage";
import type { Context } from "@/types";
import { RedisAdapter } from "@grammyjs/storage-redis";

const bot = new Bot<Context>(env.BOT_TOKEN);

bot.use(
	session({
		type: "multi",
		cookies: {
			initial: () => null,
			prefix: "user:cookies:",
			storage: new RedisAdapter({ instance: redis }),
		},
	}),
);

bot.use(async (ctx, next) => {
	ctx.logger = logger.child({});

	await next();
});

bot.use(attachUser);
bot.use(logUpdates);

export { bot, type Context };

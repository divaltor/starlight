import { Bot, session } from "grammy";

import env from "@/server/config";
import { logger } from "@/server/logger";
import logUpdates from "@/server/middlewares/logging";
import attachUser from "@/server/middlewares/session";
import { redis } from "@/server/storage";
import type { Context } from "@/server/types";
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

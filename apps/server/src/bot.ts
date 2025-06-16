import { Bot, session } from "grammy";

import { logger } from "@/logger";
import logUpdates from "@/middlewares/logging";
import { attachChat, attachUser } from "@/middlewares/session";
import { RedisAdapter, redis } from "@/storage";
import type { Context } from "@/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { env } from "@repo/utils";
import { autoQuote } from "@roziscoding/grammy-autoquote";

const bot = new Bot<Context>(env.BOT_TOKEN);

bot.use(
	session({
		type: "multi",
		cookies: {
			initial: () => null,
			prefix: "user:cookies:",
			storage: new RedisAdapter({ instance: redis, parseJSON: false }),
		},
	}),
);

bot.use(async (ctx, next) => {
	ctx.logger = logger.child({});

	await next();
});

bot.use(autoQuote());
bot.api.config.use(
	autoRetry({
		maxRetryAttempts: 3,
		maxDelaySeconds: 5,
	}),
);
bot.use(attachUser);
bot.use(attachChat);
bot.use(logUpdates);

export { bot, type Context };

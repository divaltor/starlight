import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles } from "@grammyjs/files";
import { env } from "@repo/utils";
import { autoQuote } from "@roziscoding/grammy-autoquote";
import { Bot, InlineKeyboard, session } from "grammy";
import { logger } from "@/logger";
import logUpdates from "@/middlewares/logging";
import { attachChat, attachUser } from "@/middlewares/session";
import { RedisAdapter, redis } from "@/storage";
import type { Context } from "@/types";

const bot = new Bot<Context>(env.BOT_TOKEN);

bot.use(
	session({
		type: "multi",
		cookies: {
			getSessionKey: (ctx) => ctx.from?.id.toString(),
			initial: () => null,
			prefix: "user:cookies:",
			storage: new RedisAdapter({ instance: redis, parseJSON: false }),
		},
	}),
);

export const webAppKeyboard = (
	page: "app" | "publications" | "settings",
	text: string,
) =>
	new InlineKeyboard().webApp(text, {
		url: `${env.BASE_FRONTEND_URL}/${page}`,
	});

export const channelKeyboard = (channelUsername: string) =>
	new InlineKeyboard().url("View channel", `https://t.me/${channelUsername}`);

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
bot.api.config.use(hydrateFiles(bot.token));
bot.use(attachUser);
bot.use(attachChat);
bot.use(logUpdates);

export { bot, type Context };

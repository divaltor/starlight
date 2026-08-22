import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles } from "@grammyjs/files";
import { autoQuote } from "@roziscoding/grammy-autoquote";
import { env } from "@starlight/utils";
import { Bot } from "grammy";
import { logger } from "@/logger";
import logUpdates from "@/middlewares/logging";
import { attachMessage } from "@/middlewares/message";
import { attachChat, attachChatMember, attachUser } from "@/middlewares/session";
import type { Context } from "@/types";

if (!env.STARLIGHT_BOT_TOKEN) {
	throw new Error("STARLIGHT_BOT_TOKEN is required");
}

const bot = new Bot<Context>(env.STARLIGHT_BOT_TOKEN);

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
bot.use(async (ctx, next) => {
	if (ctx.from && env.SUPERVISOR_IDS.includes(ctx.from.id)) {
		ctx.isSupervisor = true;
	}
	await next();
});
bot.use(attachUser);
bot.use(attachChat);
bot.use(attachChatMember);
bot.use(attachMessage);
bot.use(logUpdates);

export { bot };
export type { Context } from "@/types";

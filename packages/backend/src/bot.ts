import { type Context as BaseContext, Bot } from "grammy";

import env from "@/config";
import { type Logger, logger } from "@/logger";
import type { HydrateFlavor } from "@grammyjs/hydrate";

interface ExtendedContext {
	logger: Logger;
}

type Context = BaseContext & HydrateFlavor<BaseContext & ExtendedContext>;

const bot = new Bot<Context>(env.BOT_TOKEN);

bot.use(async (ctx, next) => {
	ctx.logger = logger.child({});

	await next();
});

export { bot, type Context };

import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles } from "@grammyjs/files";
import type { FileApiFlavor } from "@grammyjs/files";
import { Bot } from "grammy";
import type { Api, Context } from "grammy";
import { createBotEnv } from "@/env";

const env = createBotEnv();

export const bot = new Bot<Context, FileApiFlavor<Api>>(env.STARLIGHT_BOT_TOKEN);

bot.api.config.use(autoRetry({ maxDelaySeconds: 5, maxRetryAttempts: 3 }));

bot.api.config.use(hydrateFiles(bot.token));

export const fileApi = bot.api;

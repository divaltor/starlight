import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles } from "@grammyjs/files";
import type { FileApiFlavor } from "@grammyjs/files";
import { Bot } from "grammy";
import { createBotEnv } from "@/env";

const env = createBotEnv();

export const bot = new Bot(env.STARLIGHT_BOT_TOKEN);

bot.api.config.use(autoRetry({ maxDelaySeconds: 5, maxRetryAttempts: 3 }));
bot.api.config.use(hydrateFiles(bot.token));

export const fileApi = bot.api as FileApiFlavor<typeof bot.api>;

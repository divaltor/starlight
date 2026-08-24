import { autoRetry } from "@grammyjs/auto-retry";
import { run } from "@grammyjs/runner";
import { Effect, pipe } from "effect";
import { createBotEnv } from "@starlight/utils/env";
import { Bot } from "grammy";
import type { Context } from "grammy";
import { createMessageHandler } from "@/handlers/message";
import { createMemoryHandler } from "@/handlers/memory";
import { createStartHandler } from "@/handlers/start";
import { createUpdateTracer, initTelemetry, shutdownTelemetry } from "@/instrumentation";
import { runtime } from "@/services/runtime";

const env = createBotEnv();

initTelemetry({ langfuse: env.langfuse, otlp: env.otlp });
runtime.runSync(
  pipe(
    Effect.logInfo("Telemetry established"),
    Effect.annotateLogs({
      langfuse: env.langfuse !== undefined,
      otlp: env.otlp !== undefined,
    }),
  ),
);

const bot = new Bot<Context>(env.STARLIGHT_BOT_TOKEN);

bot.use(createUpdateTracer());
bot.api.config.use(autoRetry({ maxDelaySeconds: 5, maxRetryAttempts: 3 }));

const boundary = bot.errorBoundary((error) =>
  runtime.runSync(
    pipe(
      Effect.logError("Unhandled bot update error"),
      Effect.annotateLogs({
        updateId: error.ctx.update.update_id,
        error: error.error instanceof Error ? (error.error.stack ?? error.error.message) : String(error.error),
      }),
    ),
  ),
);

boundary.use(createStartHandler(env.WHITELIST_DM_USER_IDS));
boundary.use(createMemoryHandler(env.WHITELIST_DM_USER_IDS));
boundary.use(
  createMessageHandler({
    whitelistedChatIds: env.WHITELIST_CHAT_IDS,
    whitelistedDmUserIds: env.WHITELIST_DM_USER_IDS,
  }),
);

const runner = run(bot);
runtime.runSync(Effect.logInfo("Starlight bot is running"));

const shutdown = async () => {
  runtime.runSync(Effect.logInfo("Stopping Starlight bot"));
  if (runner.isRunning()) await runner.stop();
  await runtime.dispose();
  await shutdownTelemetry();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

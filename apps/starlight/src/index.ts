import { run } from "@grammyjs/runner";
import { Effect, pipe } from "effect";
import { bot } from "@/bot";
import { createBotEnv } from "@/env";
import guestMessageHandler from "@/handlers/guest-message";
import messageHandler from "@/handlers/message";
import startHandler from "@/handlers/start";
import { createUpdateTracer, initTelemetry, shutdownTelemetry } from "@/instrumentation";
import premiumAccess from "@/middlewares/premium-access";
import startChat from "@/middlewares/start-chat";
import { runtime } from "@/services/runtime";

const env = createBotEnv();

initTelemetry({ langfuse: env.langfuse, otlp: env.otlp });
await runtime.runPromise(
  pipe(
    Effect.logInfo("Telemetry established"),
    Effect.annotateLogs({
      langfuse: env.langfuse !== undefined,
      otlp: env.otlp !== undefined,
    }),
  ),
);

bot.use(createUpdateTracer());

const boundary = bot.errorBoundary((error) =>
  runtime.runPromise(
    pipe(
      Effect.logError("Unhandled bot update error"),
      Effect.annotateLogs({
        updateId: error.ctx.update.update_id,
        error: error.error instanceof Error ? (error.error.stack ?? error.error.message) : String(error.error),
      }),
    ),
  ),
);

boundary.use(startChat);
boundary.use(premiumAccess);
boundary.use(startHandler);
boundary.use(guestMessageHandler);
boundary.use(messageHandler);

const runner = run(bot);
await runtime.runPromise(Effect.logInfo("Starlight bot is running"));

const shutdown = async () => {
  await runtime.runPromise(Effect.logInfo("Stopping Starlight bot"));
  if (runner.isRunning()) await runner.stop();
  await runtime.dispose();
  await shutdownTelemetry();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

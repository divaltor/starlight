import { run } from "@grammyjs/runner";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { createContext } from "@starlight/api/context";
import { appRouter } from "@starlight/api/routers/index";
import { env } from "@starlight/utils";
import { webhookCallback } from "grammy";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { bot } from "@/bot";
import imageHandler from "@/handlers/image";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { classificationWorker } from "@/queue/classification";
import { embeddingsWorker } from "@/queue/embeddings";
import { imagesWorker } from "@/queue/image-collector";
import { scrapperWorker } from "@/queue/scrapper";

const boundary = bot.errorBoundary((error) => {
	const { ctx } = error;

	ctx.logger.error({
		err: error.error,
		message: error.message,
	});
});

boundary.use(videoHandler);
boundary.use(imageHandler);

if (env.USE_WEBHOOK && env.BASE_WEBHOOK_URL) {
	bot.api.setWebhook(env.BASE_WEBHOOK_URL);
} else {
	const runner = run(bot);

	process.on("SIGINT", async () => {
		logger.info("Stopping bot...");
		if (runner.isRunning()) {
			await runner.stop();
		}
	});

	process.on("SIGTERM", async () => {
		logger.info("Stopping bot...");
		if (runner.isRunning()) {
			await runner.stop();
		}
	});
}

process.on("SIGINT", async () => {
	await imagesWorker.close();
	await classificationWorker.close();
	await scrapperWorker.close();
	await embeddingsWorker.close();
});

process.on("SIGTERM", async () => {
	await imagesWorker.close();
	await classificationWorker.close();
	await scrapperWorker.close();
	await embeddingsWorker.close();
});

imagesWorker.run();
classificationWorker.run();
embeddingsWorker.run();
scrapperWorker.run();

const rpcHandler = new RPCHandler(appRouter, {
	interceptors: [
		onError((error) => {
			logger.error({ error }, "Error in RPC handler");
		}),
	],
});

const app = new Hono();

app.use(honoLogger());
app.use(
	cors({
		origin: env.CORS_ORIGIN,
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
		credentials: true,
	})
);

if (env.USE_WEBHOOK && env.BASE_WEBHOOK_URL) {
	app.use("/webhook*", webhookCallback(bot, "hono"));
}
app.all("/rpc*", async (ctx) => {
	const context = await createContext({ context: ctx });

	const rpcResult = await rpcHandler.handle(ctx.req.raw, {
		prefix: "/rpc",
		context,
	});

	if (rpcResult.matched) {
		return ctx.newResponse(rpcResult.response.body, rpcResult.response);
	}
});

app.get("/", (c) => c.text("OK"));

export default app;

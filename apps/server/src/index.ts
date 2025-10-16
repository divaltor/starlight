import cors from "@elysiajs/cors";
import { run } from "@grammyjs/runner";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { createContext } from "@starlight/api/context";
import { appRouter } from "@starlight/api/routers/index";
import { env, logger } from "@starlight/utils";
import Elysia from "elysia";
import { bot } from "@/bot";
import imageHandler from "@/handlers/image";
import publicationsHandler from "@/handlers/publications";
import videoHandler from "@/handlers/video";
import { classificationWorker } from "@/queue/classification";
import { imagesWorker } from "@/queue/image-collector";
import { scheduledSlotWorker, scheduledTweetWorker } from "@/queue/scheduler";
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
boundary.use(publicationsHandler);

logger.info("Bot is starting...");

const runner = run(bot);

process.on("SIGINT", async () => {
	await imagesWorker.close();
	await classificationWorker.close();
	await scrapperWorker.close();
	await scheduledTweetWorker.close();
	await scheduledSlotWorker.close();
	if (runner.isRunning()) {
		await runner.stop();
	}
});

process.on("SIGTERM", async () => {
	await imagesWorker.close();
	await classificationWorker.close();
	await scrapperWorker.close();
	await scheduledTweetWorker.close();
	await scheduledSlotWorker.close();
	if (runner.isRunning()) {
		await runner.stop();
	}
});

imagesWorker.run();
classificationWorker.run();
scrapperWorker.run();
scheduledTweetWorker.run();
scheduledSlotWorker.run();

const rpcHandler = new RPCHandler(appRouter, {
	interceptors: [
		onError((error) => {
			logger.error({ error }, "Error in RPC handler");
		}),
	],
});

const _ = new Elysia()
	.use(
		cors({
			origin: env.CORS_ORIGIN,
			methods: ["GET", "POST", "OPTIONS"],
		})
	)
	.all("/rpc*", async (context) => {
		const { response } = await rpcHandler.handle(context.request, {
			prefix: "/rpc",
			context: await createContext({ context }),
		});
		return response ?? new Response("Not Found", { status: 404 });
	})
	.get("/", () => "OK")
	.listen(3000, () => {
		logger.info("Server is running on http://localhost:3000");
	});

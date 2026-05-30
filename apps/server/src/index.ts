import { initTelemetry, shutdownTelemetry } from "@/instrumentation";
import { run } from "@grammyjs/runner";
import { bot } from "@/bot";
import "@/services/runtime";
import chatMemberHandler from "@/handlers/chat-member";
import imageHandler from "@/handlers/image";
import messageHandler from "@/handlers/message";
import startHandler from "@/handlers/start";
import tweetImageHandler from "@/handlers/tweet-image";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { QUEUES } from "@/queue/absurd";
import { classificationApp } from "@/queue/classification";
import { embeddingsApp } from "@/queue/embeddings";
import { imagesApp } from "@/queue/image-collector";
import { memoryApp } from "@/queue/memory";
import { scrapperApp } from "@/queue/scrapper";

initTelemetry();

const boundary = bot.errorBoundary((error) => {
	const { ctx } = error;

	ctx.logger.error({
		err: error.error,
		message: error.message,
	});
});

boundary.use(videoHandler);
boundary.use(tweetImageHandler);
boundary.use(imageHandler);
boundary.use(messageHandler);
boundary.use(startHandler);
boundary.use(chatMemberHandler);

await Promise.all(
	[imagesApp, classificationApp, embeddingsApp, scrapperApp, memoryApp].map(async (app) => {
		await app.createQueue();
		await app.setQueuePolicy(undefined, {
			cleanupLimit: 2000,
			cleanupTtl: "1 day",
		});
	}),
);
const workers = await Promise.all([
	imagesApp.startWorker({
		batchSize: 3,
		concurrency: 3,
		onError: (error) => logger.error({ error }, "Images worker error"),
		workerId: QUEUES.images,
	}),
	classificationApp.startWorker({
		batchSize: 1,
		claimTimeout: 60 * 5,
		concurrency: 1,
		onError: (error) => logger.error({ error }, "Classification worker error"),
		workerId: QUEUES.classification,
	}),
	embeddingsApp.startWorker({
		batchSize: 1,
		claimTimeout: 60 * 5,
		concurrency: 1,
		onError: (error) => logger.error({ error }, "Embeddings worker error"),
		workerId: QUEUES.embeddings,
	}),
	scrapperApp.startWorker({
		batchSize: 1,
		concurrency: 1,
		onError: (error) => logger.error({ error }, "Scrapper worker error"),
		workerId: QUEUES.scrapper,
	}),
	memoryApp.startWorker({
		batchSize: 2,
		claimTimeout: 60 * 5,
		concurrency: 2,
		onError: (error) => logger.error({ error }, "Memory worker error"),
		workerId: QUEUES.memory,
	}),
]);
const queueApps = [imagesApp, classificationApp, embeddingsApp, scrapperApp, memoryApp];
const runner = run(bot);

logger.info("Bot is running...");

process.once("SIGINT", async () => {
	logger.info("Stopping bot...");
	if (runner.isRunning()) {
		await runner.stop();
	}
	await Promise.all(workers.map((worker) => worker.close()));
	await Promise.all(queueApps.map((app) => app.close()));
	await shutdownTelemetry();
});

process.once("SIGTERM", async () => {
	logger.info("Stopping bot...");
	if (runner.isRunning()) {
		await runner.stop();
	}
	await Promise.all(workers.map((worker) => worker.close()));
	await Promise.all(queueApps.map((app) => app.close()));
	await shutdownTelemetry();
});

import { initTelemetry, shutdownTelemetry } from "@/instrumentation";
import { run } from "@grammyjs/runner";
import { bot } from "@/bot";
import "@/services/runtime";
import chatMemberHandler from "@/handlers/chat-member";
import imageHandler from "@/handlers/image";
import messageHandler from "@/handlers/message";
import pixivHandler from "@/handlers/pixiv";
import scrapperHandler from "@/handlers/scrapper";
import startHandler from "@/handlers/start";
import tweetImageHandler from "@/handlers/tweet-image";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { classificationQueue, classificationWorker } from "@/queue/classification";
import { embeddingsQueue, embeddingsWorker } from "@/queue/embeddings";
import { mediaCollectorQueue, mediaCollectorWorker } from "@/queue/media-collector";
import { memoryQueue, memoryWorker } from "@/queue/memory";
import { pixivQueue, pixivWorker } from "@/queue/pixiv";
import { scrapperQueue, scrapperWorker } from "@/queue/scrapper";
import { redis } from "@/storage";

initTelemetry();

const boundary = bot.errorBoundary((error) => {
	const { ctx } = error;

	ctx.logger.error(
		{
			err: error.error,
			message: error.message,
		},
		"Unhandled bot update error",
	);
});

boundary.use(videoHandler);
boundary.use(pixivHandler);
boundary.use(tweetImageHandler);
boundary.use(scrapperHandler);
boundary.use(imageHandler);
boundary.use(messageHandler);
boundary.use(startHandler);
boundary.use(chatMemberHandler);

const workers = [
	mediaCollectorWorker,
	classificationWorker,
	embeddingsWorker,
	scrapperWorker,
	memoryWorker,
	pixivWorker,
];
const queues = [
	mediaCollectorQueue,
	classificationQueue,
	embeddingsQueue,
	scrapperQueue,
	memoryQueue,
	pixivQueue,
];
const runner = run(bot);

for (const worker of workers) {
	worker.run().catch((error) => logger.error({ err: error }, "Queue worker stopped"));
}

logger.info("Bot is running...");

async function shutdown() {
	logger.info("Stopping bot...");
	if (runner.isRunning()) {
		await runner.stop();
	}
	await Promise.all(workers.map((worker) => worker.close()));
	await Promise.all(queues.map((queue) => queue.close()));
	await redis.quit();
	await shutdownTelemetry();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

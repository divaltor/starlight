import { run } from "@grammyjs/runner";
import { bot } from "@/bot";
import "@/services/runtime";
import chatMemberHandler from "@/handlers/chat-member";
import imageHandler from "@/handlers/image";
import startHandler from "@/handlers/start";
import tweetImageHandler from "@/handlers/tweet-image";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { classificationQueue, classificationWorker } from "@/queue/classification";
import { embeddingsQueue, embeddingsWorker } from "@/queue/embeddings";
import { imagesQueue, imagesWorker } from "@/queue/image-collector";
import { scrapperQueue, scrapperWorker } from "@/queue/scrapper";
import { redis } from "@/storage";

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
boundary.use(tweetImageHandler);
boundary.use(imageHandler);
boundary.use(startHandler);
boundary.use(chatMemberHandler);

const workers = [imagesWorker, classificationWorker, embeddingsWorker, scrapperWorker];
const queues = [imagesQueue, classificationQueue, embeddingsQueue, scrapperQueue];
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
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

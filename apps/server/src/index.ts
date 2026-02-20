import { run } from "@grammyjs/runner";
import { bot } from "@/bot";
import imageHandler from "@/handlers/image";
import tweetImageHandler from "@/handlers/tweet-image";
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
boundary.use(tweetImageHandler);
boundary.use(imageHandler);

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

import { run } from "@grammyjs/runner";
import { bot } from "@/bot";
import chatMemberHandler from "@/handlers/chat-member";
import imageHandler from "@/handlers/image";
import messageHandler from "@/handlers/message";
import tweetImageHandler from "@/handlers/tweet-image";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { registerTelemetry } from "@/otel";
import { classificationWorker } from "@/queue/classification";
import { embeddingsWorker } from "@/queue/embeddings";
import { imagesWorker } from "@/queue/image-collector";
import { memoryWorker } from "@/queue/memory";
import { scrapperWorker } from "@/queue/scrapper";

registerTelemetry();

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
boundary.use(chatMemberHandler);

const runner = run(bot);

logger.info("Bot is running...");

process.once("SIGINT", async () => {
	logger.info("Stopping bot...");
	if (runner.isRunning()) {
		await runner.stop();
	}
	await imagesWorker.close();
	await classificationWorker.close();
	await scrapperWorker.close();
	await embeddingsWorker.close();
	await memoryWorker.close();
});

process.once("SIGTERM", async () => {
	logger.info("Stopping bot...");
	if (runner.isRunning()) {
		await runner.stop();
	}
	await imagesWorker.close();
	await classificationWorker.close();
	await scrapperWorker.close();
	await embeddingsWorker.close();
	await memoryWorker.close();
});

imagesWorker.run();
classificationWorker.run();
embeddingsWorker.run();
scrapperWorker.run();
memoryWorker.run();

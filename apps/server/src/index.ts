import { run } from "@grammyjs/runner";
import dotenv from "dotenv";
import { bot } from "@/bot";
import imageHandler from "@/handlers/image";
import publicationsHandler from "@/handlers/publications";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { imagesWorker } from "@/queue/image-collector";
import { scheduledSlotWorker, scheduledTweetWorker } from "@/queue/scheduler";
import { scrapperWorker } from "@/queue/scrapper";

dotenv.config({ path: ".env" });

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
	await scrapperWorker.close();
	await scheduledTweetWorker.close();
	await scheduledSlotWorker.close();
	if (runner.isRunning()) await runner.stop();
});

process.on("SIGTERM", async () => {
	await imagesWorker.close();
	await scrapperWorker.close();
	await scheduledTweetWorker.close();
	await scheduledSlotWorker.close();
	if (runner.isRunning()) await runner.stop();
});

imagesWorker.run();
scrapperWorker.run();
scheduledTweetWorker.run();
scheduledSlotWorker.run();

import { bot } from "@/bot";
import imageHandler from "@/handlers/image";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";
import { imagesWorker } from "@/queue/image-collector";
import { publishingWorker } from "@/queue/publishing";
import { scrapperWorker } from "@/queue/scrapper";
import { run } from "@grammyjs/runner";
import dotenv from "dotenv";

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

logger.info("Bot is starting...");

const runner = run(bot);

process.on("SIGINT", async () => {
	await imagesWorker.close();
	await scrapperWorker.close();
	await publishingWorker.close();
	if (runner.isRunning()) await runner.stop();
});

process.on("SIGTERM", async () => {
	await imagesWorker.close();
	await scrapperWorker.close();
	await publishingWorker.close();
	if (runner.isRunning()) await runner.stop();
});

imagesWorker.run();
scrapperWorker.run();
publishingWorker.run();

import { bot } from "@/server/bot";
import imageHandler from "@/server/handlers/image";
import videoHandler from "@/server/handlers/video";
import { logger } from "@/server/logger";
import { imagesWorker } from "@/server/queue/image-collector";
import { run } from "@grammyjs/runner";

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
	if (runner.isRunning()) await runner.stop();
});

process.on("SIGTERM", async () => {
	await imagesWorker.close();
	if (runner.isRunning()) await runner.stop();
});

imagesWorker.run();

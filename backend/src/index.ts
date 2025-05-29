import { bot } from "@/bot";
import imageHandler from "@/handlers/image";
import videoHandler from "@/handlers/video";
import { logger } from "@/logger";

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

bot.start();
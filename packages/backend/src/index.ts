import { bot } from "@/bot";
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

logger.info("Bot is starting...");

bot.start();
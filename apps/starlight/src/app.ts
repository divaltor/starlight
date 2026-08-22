import { initTelemetry, shutdownTelemetry } from "@/instrumentation";
import { run } from "@grammyjs/runner";
import { bot } from "@/bot";
import "@/services/runtime";
import messageHandler from "@/handlers/message";
import startHandler from "@/handlers/start";
import { logger } from "@/logger";
import { memoryQueue, memoryWorker } from "@/queue/memory";
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

boundary.use(messageHandler);
boundary.use(startHandler);

const workers = [memoryWorker];
const queues = [memoryQueue];
const runner = run(bot);

for (const worker of workers) {
	worker.run().catch((error) => logger.error({ err: error }, "Queue worker stopped"));
}

logger.info("Starlight bot is running");

async function shutdown() {
	logger.info("Stopping Starlight bot");
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

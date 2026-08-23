import { initTelemetry, shutdownTelemetry } from "@/instrumentation";
import { run } from "@grammyjs/runner";
import type { Update } from "@grammyjs/types";
import { bot } from "@/bot";
import "@/services/runtime";
import messageHandler from "@/handlers/message";
import startHandler from "@/handlers/start";
import { logger } from "@/logger";
import { memoryQueue, memoryWorker } from "@/queue/memory";
import { redis } from "@/storage";

initTelemetry();

const UPDATE_PROCESSING_TIMEOUT_MS = 1000 * 60 * 10;

function handleUpdateTimeout(update: Update, task: Promise<void>) {
	// The runner evicts the drift so the update stops pinning a slot and its
	// context; the middleware itself keeps running until it settles.
	const updateType = Object.keys(update).find((key) => key !== "update_id") ?? "unknown";

	logger.error(
		{ updateId: update.update_id, updateType },
		"Update handler timed out; evicted from runner queue",
	);

	task.catch((error) => {
		logger.error(
			{ err: error, updateId: update.update_id, updateType },
			"Timed-out update handler failed",
		);
	});
}

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
const runner = run(bot, {
	sink: {
		timeout: {
			milliseconds: UPDATE_PROCESSING_TIMEOUT_MS,
			handler: handleUpdateTimeout,
		},
	},
});

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

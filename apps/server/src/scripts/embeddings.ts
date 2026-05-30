import { prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { RETRY } from "@/queue/absurd";
import { embeddingsApp } from "@/queue/embeddings";

// Manual script: enqueue embeddings jobs for ALL available photos (no batching)
// Usage: bun run apps/server/src/scripts/enqueue-all-embeddings.ts
// Optional env vars:
//   DRY_RUN=1             (only log, do not enqueue)
//   CLEAR_QUEUE=1         (drop and recreate the Absurd queue before enqueueing)
//   FORCE=1               (enqueue even if jobs existed previously; bypass dedupe)
// Notes:
//   FORCE only bypasses queue task de-duplication. The worker still skips
//   photos that already have embeddings saved.

const DRY_RUN = process.env.DRY_RUN === "1";
const CLEAR_QUEUE = process.env.CLEAR_QUEUE === "1" || process.env.CLEAR === "1";
const FORCE = process.env.FORCE === "1";

async function main() {
	await embeddingsApp.createQueue();
	await embeddingsApp.setQueuePolicy(undefined, {
		cleanupLimit: 2000,
		cleanupTtl: "1 day",
	});

	logger.info(
		{
			dryRun: DRY_RUN,
			clear: CLEAR_QUEUE,
			force: FORCE,
		},
		"Starting enqueue of all photos for embeddings",
	);

	if (CLEAR_QUEUE) {
		await embeddingsApp.dropQueue();
		await embeddingsApp.createQueue();
		await embeddingsApp.setQueuePolicy(undefined, {
			cleanupLimit: 2000,
			cleanupTtl: "1 day",
		});
		logger.info("Embeddings queue dropped and recreated");
	}

	const photos = await prisma.$queryRaw<{ id: string; userId: string }[]>`
		SELECT id, user_id as "userId"
		FROM photos
		WHERE deleted_at IS NULL
		  AND s3_path IS NOT NULL
		  AND (
			image_vec IS NULL
			OR tag_vec IS NULL
		  )
		ORDER BY id ASC
	`;

	let enqueued = 0;

	if (!DRY_RUN && photos.length > 0) {
		await Promise.all(
			photos.map((photo) => {
				const data = { photoId: photo.id, userId: photo.userId };

				return FORCE
					? embeddingsApp.spawn("embeddings", data, {
							maxAttempts: 5,
							retryStrategy: RETRY.embeddings,
						})
					: embeddingsApp.spawn("embeddings", data, {
							idempotencyKey: `embed-${data.photoId}-${data.userId}`,
							maxAttempts: 5,
							retryStrategy: RETRY.embeddings,
						});
			}),
		);
		enqueued = photos.length;
	}

	logger.info(
		{
			enqueued,
			dryRun: DRY_RUN,
			force: FORCE,
			clearQueue: CLEAR_QUEUE,
		},
		"Finished enqueue script",
	);
}

main()
	.catch((error) => {
		logger.error({ error }, "Enqueue script failed");
		process.exitCode = 1;
	})
	.finally(async () => {
		await embeddingsApp.close().catch((error) => {
			logger.error({ error }, "Failed to close embeddings queue client");
		});
		await prisma.$disconnect().catch((error) => {
			logger.error({ error }, "Failed to disconnect from database");
		});
	});

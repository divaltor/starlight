import { env, prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { embeddingsQueue } from "@/queue/embeddings";
import { redis } from "@/storage";

// Manual script: enqueue embeddings jobs for ALL available photos (no batching)
// Usage: bun run apps/server/src/scripts/enqueue-all-embeddings.ts
// Optional env vars:
//   DRY_RUN=1             (only log, do not enqueue)
//   CLEAR_QUEUE=1         (drain waiting & delayed jobs before enqueueing)
//   FORCE=1               (enqueue even if jobs existed previously; bypass dedupe)
// Notes:
//   FORCE only bypasses queue job de-duplication. The worker still skips
//   photos that already have embeddings saved.

const DRY_RUN = process.env.DRY_RUN === "1";
const CLEAR_QUEUE =
	process.env.CLEAR_QUEUE === "1" || process.env.CLEAR === "1";
const FORCE = process.env.FORCE === "1";

async function main() {
	logger.info(
		{
			dryRun: DRY_RUN,
			clear: CLEAR_QUEUE,
			force: FORCE,
		},
		"Starting enqueue of all photos for embeddings"
	);

	if (CLEAR_QUEUE && !DRY_RUN) {
		try {
			await embeddingsQueue.drain(true);
			logger.info("Embeddings queue drained (waiting & delayed jobs removed)");
		} catch (error) {
			logger.error({ error }, "Failed to drain embeddings queue");
		}
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
		await embeddingsQueue.addBulk(
			photos.map((p) => {
				const base = `embed-${p.id}-${p.userId}`;
				const jobId = FORCE ? `${base}-${Date.now()}` : base;
				return {
					name: `embed-${p.id}`,
					data: { photoId: p.id, userId: p.userId },
					// Only enable deduplication when not forcing
					opts: FORCE ? { jobId } : { jobId, deduplication: { id: base } },
				};
			})
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
		"Finished enqueue script"
	);
}

main()
	.catch((error) => {
		logger.error({ error }, "Enqueue script failed");
		process.exitCode = 1;
	})
	.finally(async () => {
		await embeddingsQueue.close().catch((error) => {
			logger.error({ error }, "Failed to close embeddings queue");
		});
		await prisma.$disconnect().catch((error) => {
			logger.error({ error }, "Failed to disconnect from database");
		});
		await redis.quit().catch((error) => {
			logger.error({ error }, "Failed to quit Redis");
		});
		if (env.NODE_ENV !== "production") {
			setTimeout(() => process.exit(), 100).unref();
		}
	});

import { prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { classificationQueue } from "@/queue/classification";
import { redis } from "@/storage";

// Manual script: enqueue classification jobs for ALL available photos (no batching)
// Usage: bun run apps/server/src/scripts/enqueue-all-classifications.ts
// Optional env vars:
//   DRY_RUN=1             (only log, do not enqueue)
//   CLEAR_QUEUE=1         (drain waiting & delayed jobs before enqueueing)
//   FORCE=1               (enqueue even if jobs existed previously; bypass dedupe)
//   ALL_PICTURES=1        (enqueue all pictures)
// Notes:
//   FORCE only bypasses queue job de-duplication. The worker still skips
//   photos that already have a classification saved.

const DRY_RUN = process.env.DRY_RUN === "1";
const CLEAR_QUEUE =
	process.env.CLEAR_QUEUE === "1" || process.env.CLEAR === "1";
const FORCE = process.env.FORCE === "1";
// When set, only enqueue photos missing classification.nsfw.is_nsfw
const ALL_PICTURES = process.env.ALL_PICTURES === "1";

async function main() {
	logger.info(
		{
			dryRun: DRY_RUN,
			clear: CLEAR_QUEUE,
			force: FORCE,
			onlyMissingNsfw: ALL_PICTURES,
		},
		"Starting enqueue of all photos for classification"
	);

	if (CLEAR_QUEUE) {
		try {
			await classificationQueue.drain(true);
			logger.info(
				"Classification queue drained (waiting & delayed jobs removed)"
			);
		} catch (error) {
			logger.error({ error }, "Failed to drain classification queue");
		}
	}

	const photos = ALL_PICTURES
		? await prisma.photo.findMany({
				where: { deletedAt: null, s3Path: { not: null } },
				select: { id: true, userId: true },
				orderBy: { id: "asc" },
			})
		: await prisma.$queryRaw<{ id: string; userId: string }[]>`
			SELECT id, user_id as "userId"
			FROM photos
			WHERE deleted_at IS NULL
			  AND s3_path IS NOT NULL
			  AND (
			    classification IS NULL
			    OR (classification -> 'nsfw') IS NULL
			    OR (classification -> 'nsfw' -> 'is_nsfw') IS NULL
			  )
			ORDER BY id ASC
		`;

	logger.info({ count: photos.length }, "Fetched all photos to enqueue");

	let enqueued = 0;
	if (!DRY_RUN && photos.length > 0) {
		await classificationQueue.addBulk(
			photos.map((p) => {
				const base = `classify-${p.id}-${p.userId}`;
				const jobId = FORCE ? `${base}-${Date.now()}` : base;
				return {
					name: `classify-${p.id}`,
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
			onlyMissingNsfw: ALL_PICTURES,
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
		await classificationQueue.close().catch((error) => {
			logger.error({ error }, "Failed to close classification queue");
		});
		await prisma.$disconnect().catch((error) => {
			logger.error({ error }, "Failed to disconnect from database");
		});
		await redis.quit().catch((error) => {
			logger.error({ error }, "Failed to quit Redis");
		});
	});

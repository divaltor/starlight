import { prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { RETRY } from "@/queue/absurd";
import { classificationApp } from "@/queue/classification";

// Manual script: enqueue classification jobs for ALL available photos (no batching)
// Usage: bun run apps/server/src/scripts/enqueue-all-classifications.ts
// Optional env vars:
//   DRY_RUN=1             (only log, do not enqueue)
//   CLEAR_QUEUE=1         (drop and recreate the Absurd queue before enqueueing)
//   FORCE=1               (enqueue even if jobs existed previously; bypass dedupe)
//   ALL_PICTURES=1        (enqueue all pictures)
// Notes:
//   FORCE only bypasses queue task de-duplication. The worker still skips
//   photos that already have a classification saved.

const DRY_RUN = process.env.DRY_RUN === "1";
const CLEAR_QUEUE = process.env.CLEAR_QUEUE === "1" || process.env.CLEAR === "1";
const FORCE = process.env.FORCE === "1";
// When set, enqueue all photos regardless of stored classification state
const ALL_PICTURES = process.env.ALL_PICTURES === "1";

async function main() {
	await classificationApp.createQueue();
	await classificationApp.setQueuePolicy(undefined, {
		cleanupLimit: 2000,
		cleanupTtl: "1 day",
	});

	logger.info(
		{
			dryRun: DRY_RUN,
			clear: CLEAR_QUEUE,
			force: FORCE,
			allPictures: ALL_PICTURES,
		},
		"Starting enqueue of all photos for classification",
	);

	if (CLEAR_QUEUE) {
		await classificationApp.dropQueue();
		await classificationApp.createQueue();
		await classificationApp.setQueuePolicy(undefined, {
			cleanupLimit: 2000,
			cleanupTtl: "1 day",
		});
		logger.info("Classification queue dropped and recreated");
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
			    OR jsonb_typeof(classification -> 'characters') IS DISTINCT FROM 'array'
			    OR jsonb_typeof(classification -> 'tags') IS DISTINCT FROM 'array'
			  )
			ORDER BY id ASC
		`;

	logger.info({ count: photos.length }, "Fetched all photos to enqueue");

	let enqueued = 0;
	if (!DRY_RUN && photos.length > 0) {
		await Promise.all(
			photos.map((photo) => {
				const data = { photoId: photo.id, userId: photo.userId };

				return FORCE
					? classificationApp.spawn("classification", data, {
							maxAttempts: 5,
							retryStrategy: RETRY.classification,
						})
					: classificationApp.spawn("classification", data, {
							idempotencyKey: `classify-${data.photoId}-${data.userId}`,
							maxAttempts: 5,
							retryStrategy: RETRY.classification,
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
			allPictures: ALL_PICTURES,
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
		await classificationApp.close().catch((error) => {
			logger.error({ error }, "Failed to close classification queue client");
		});
		await prisma.$disconnect().catch((error) => {
			logger.error({ error }, "Failed to disconnect from database");
		});
	});

import { Prisma, prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { classificationQueue, classificationWorker } from "@/queue/classification";
import { embeddingsQueue, embeddingsWorker } from "@/queue/embeddings";
import { redis } from "@/storage";

// Manual script: enqueue classification jobs for ALL available photos (no batching)
// Usage: bun run apps/server/src/scripts/enqueue-all-classifications.ts
// Optional env vars:
//   DRY_RUN=1             (only log, do not enqueue)
//   CLEAR_QUEUE=1         (drain waiting and delayed jobs before enqueueing)
//   FORCE=1               (enqueue even if jobs existed previously; bypass dedupe)
//   ALL_PICTURES=1        (enqueue all pictures)
//   TAGGER=<version>      (also enqueue photos classified by another tagger version)
// Notes:
//   FORCE only bypasses queue job de-duplication. The worker always overwrites
//   the stored classification.
//   Jobs are enqueued at low priority, so photos from the image collector run first.

const DRY_RUN = process.env.DRY_RUN === "1";
const CLEAR_QUEUE = process.env.CLEAR_QUEUE === "1" || process.env.CLEAR === "1";
const FORCE = process.env.FORCE === "1";

// When set, enqueue all photos regardless of stored classification state
const ALL_PICTURES = process.env.ALL_PICTURES === "1";

const { TAGGER } = process.env;

const otherTagger =
  TAGGER === undefined ? Prisma.empty : Prisma.sql`OR classification ->> 'tagger' IS DISTINCT FROM ${TAGGER}`;

// Jobs without a priority run before prioritized ones in BullMQ.
const BACKFILL_PRIORITY = 10;

async function main() {
  logger.info(
    {
      dryRun: DRY_RUN,
      clear: CLEAR_QUEUE,
      force: FORCE,
      allPictures: ALL_PICTURES,
      tagger: TAGGER,
    },
    "Starting enqueue of all photos for classification",
  );

  if (CLEAR_QUEUE) {
    await classificationQueue.drain(true);
    logger.info("Classification queue drained");
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
			    ${otherTagger}
			  )
			ORDER BY id ASC
		`;

  logger.info({ count: photos.length }, "Fetched all photos to enqueue");

  let enqueued = 0;

  if (!DRY_RUN && photos.length > 0) {
    await classificationQueue.addBulk(
      photos.map((photo) => {
        const base = `classify-${photo.id}-${photo.userId}`;
        const jobId = FORCE ? `${base}-${Date.now()}` : base;

        return {
          name: `classify-${photo.id}`,
          data: { photoId: photo.id, userId: photo.userId },
          opts: FORCE
            ? { jobId, priority: BACKFILL_PRIORITY }
            : { jobId, priority: BACKFILL_PRIORITY, deduplication: { id: base } },
        };
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
      tagger: TAGGER,
    },
    "Finished enqueue script",
  );
}

try {
  await main();
} catch (error) {
  logger.error({ error }, "Enqueue script failed");
  process.exitCode = 1;
} finally {
  await Promise.all([classificationWorker.close(), embeddingsWorker.close()]).catch((cause: unknown) => {
    logger.error({ error: cause }, "Failed to close queue workers");
  });
  await Promise.all([classificationQueue.close(), embeddingsQueue.close()]).catch((cause: unknown) => {
    logger.error({ error: cause }, "Failed to close queue clients");
  });
  await prisma.$disconnect().catch((cause: unknown) => {
    logger.error({ error: cause }, "Failed to disconnect from database");
  });
  await redis.quit().catch((cause: unknown) => {
    logger.error({ error: cause }, "Failed to quit Redis");
  });
}

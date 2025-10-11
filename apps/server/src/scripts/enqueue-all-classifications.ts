import { classificationQueue } from "@/queue/classification";
import { prisma, redis } from "@/storage";
import { logger } from "@/logger";
import { env } from "@repo/utils";

// Manual script: enqueue classification jobs for ALL available photos (no batching)
// Usage: bun run apps/server/src/scripts/enqueue-all-classifications.ts
// Optional env vars:
//   DRY_RUN=1  (only log, do not enqueue)

const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
	logger.info(
		{ dryRun: DRY_RUN },
		"Starting enqueue of all photos for classification"
	);

	const photos = await prisma.photo.findMany({
		where: { deletedAt: null, s3Path: { not: null } },
		select: { id: true, userId: true },
		orderBy: { id: "asc" },
	});

	logger.info({ count: photos.length }, "Fetched all photos to enqueue");

	if (!DRY_RUN && photos.length > 0) {
		await classificationQueue.addBulk(
			photos.map((p) => ({
				name: `classify-${p.id}`,
				data: { photoId: p.id, userId: p.userId },
				opts: {
					jobId: `classify-${p.id}-${p.userId}`,
					deduplication: { id: `classify-${p.id}-${p.userId}` },
				},
			}))
		);
	}

	logger.info(
		{ enqueued: DRY_RUN ? 0 : photos.length, dryRun: DRY_RUN },
		"Finished enqueue script"
	);
}

main()
	.catch((error) => {
		logger.error({ error }, "Enqueue script failed");
		process.exitCode = 1;
	})
	.finally(async () => {
		await classificationQueue.close().catch(() => {});
		await prisma.$disconnect().catch(() => {});
		await redis.quit().catch(() => {});
		if (env.ENVIRONMENT !== "prod") {
			setTimeout(() => process.exit(), 100).unref();
		}
	});

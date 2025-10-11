import { classificationQueue } from "@/queue/classification";
import { prisma, redis } from "@/storage";
import { logger } from "@/logger";
import { env } from "@repo/utils";

// Small manual script to enqueue classification jobs for all available photos
// Usage: bun run apps/server/src/scripts/enqueue-all-classifications.ts
// Optional env vars:
//   BATCH_SIZE (default 200)
//   DRY_RUN (set to 1 to only log what would be enqueued)

const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE || "200", 10);
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
	logger.info(
		{ batchSize: BATCH_SIZE, dryRun: DRY_RUN },
		"Starting enqueue of unclassified photos"
	);

	let total = 0;
	let cursor: { id: string; userId: string } | undefined;
	for (;;) {
		const photos = await prisma.photo.findMany({
			where: {
				deletedAt: null,
				s3Path: { not: null },
			},
			select: { id: true, userId: true, classification: true },
			orderBy: { id: "asc" },
			cursor: cursor
				? { photoId: { id: cursor.id, userId: cursor.userId } }
				: undefined,
			take: BATCH_SIZE,
			skip: cursor ? 1 : 0,
		});

		if (photos.length === 0) break;

		const lastPhoto = photos.at(-1);
		if (photos.length > 0) {
			const firstPhoto = photos.at(0);
			logger.info(
				{
					batch: photos.length,
					from: firstPhoto ? firstPhoto.id : undefined,
					to: lastPhoto ? lastPhoto.id : undefined,
				},
				"Fetched batch of photos"
			);
		}

		if (!DRY_RUN) {
			await classificationQueue.addBulk(
				photos.map((p) => ({
					name: `classify-${p.id}`,
					data: { photoId: p.id, userId: p.userId },
					opts: {
						// Ensure we do not enqueue duplicate classification jobs
						jobId: `classify-${p.id}-${p.userId}`,
						deduplication: { id: `classify-${p.id}-${p.userId}` },
					},
				}))
			);
		}

		total += photos.length;
		cursor = lastPhoto
			? { id: lastPhoto.id, userId: lastPhoto.userId }
			: undefined;

		if (photos.length < BATCH_SIZE) break; // No more records
	}

	logger.info({ total, dryRun: DRY_RUN }, "Finished enqueue script");
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
			// Allow Bun to exit
			setTimeout(() => process.exit(), 100).unref();
		}
	});

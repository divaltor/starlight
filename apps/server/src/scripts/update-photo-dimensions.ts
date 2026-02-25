import { prisma } from "@starlight/utils";
import sharp from "sharp";
import { logger } from "@/logger";
import { s3 } from "@/storage";

// Manual script: update height/width for photos missing dimensions
// Usage: bun run apps/server/src/scripts/update-photo-dimensions.ts
// Optional env vars:
//   DRY_RUN=1             (only log, do not update)
//   BATCH_SIZE=100        (batch size for processing, default: 50)

const DRY_RUN = process.env.DRY_RUN === "1";
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE || "25", 10);

async function main() {
	logger.info(
		{
			dryRun: DRY_RUN,
			batchSize: BATCH_SIZE,
		},
		"Starting photo dimensions update",
	);

	// Find photos with null height or width that have s3Path
	const photos = await prisma.photo.findMany({
		where: {
			deletedAt: null,
			s3Path: { not: null },
			OR: [{ height: null }, { width: null }],
		},
		select: {
			id: true,
			userId: true,
			s3Path: true,
			height: true,
			width: true,
		},
		orderBy: { createdAt: "asc" },
	});

	logger.info({ count: photos.length }, "Found photos missing dimensions");

	if (photos.length === 0) {
		logger.info("No photos need dimension updates");
		return;
	}

	let updated = 0;
	let failed = 0;

	// Process in batches
	for (let i = 0; i < photos.length; i += BATCH_SIZE) {
		const batch = photos.slice(i, i + BATCH_SIZE);

		logger.info(
			{
				batch: Math.floor(i / BATCH_SIZE) + 1,
				totalBatches: Math.ceil(photos.length / BATCH_SIZE),
			},
			"Processing batch",
		);

		await Promise.allSettled(
			batch.map(async (photo) => {
				try {
					if (!photo.s3Path) {
						logger.warn({ photoId: photo.id, userId: photo.userId }, "Photo has no s3Path");
						return;
					}

					// Download image from S3
					const imageBuffer = await s3.file(photo.s3Path).arrayBuffer();

					// Get metadata using sharp
					const metadata = await sharp(imageBuffer)
						.metadata()
						.catch(() => ({ height: null, width: null }));

					if (!(metadata.height && metadata.width)) {
						logger.warn(
							{ photoId: photo.id, userId: photo.userId, metadata },
							"Failed to extract dimensions",
						);
						failed++;
						return;
					}

					if (!DRY_RUN) {
						// Update photo with dimensions
						await prisma.photo.update({
							where: { photoId: { id: photo.id, userId: photo.userId } },
							data: {
								height: metadata.height,
								width: metadata.width,
							},
						});
					}

					logger.debug(
						{
							photoId: photo.id,
							userId: photo.userId,
							height: metadata.height,
							width: metadata.width,
							dryRun: DRY_RUN,
						},
						"Updated photo dimensions",
					);

					updated++;
				} catch (error) {
					logger.error(
						{ error, photoId: photo.id, userId: photo.userId },
						"Failed to update photo dimensions",
					);
					failed++;
				}
			}),
		);
	}

	logger.info(
		{
			total: photos.length,
			updated,
			failed,
			dryRun: DRY_RUN,
			batchSize: BATCH_SIZE,
		},
		"Finished photo dimensions update",
	);
}

main()
	.catch((error) => {
		logger.error({ error }, "Photo dimensions update script failed");
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect().catch((error) => {
			logger.error({ error }, "Failed to disconnect from database");
		});
	});

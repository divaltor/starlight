import { prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { s3 } from "@/storage";

// Manual script: update height/width for media missing dimensions
// Usage: bun run apps/server/src/scripts/update-media-dimensions.ts
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
		"Starting media dimensions update",
	);

	// Find media with null height or width that have s3Path
	const media = await prisma.media.findMany({
		where: {
			deletedAt: null,
			s3Path: { not: null },
			OR: [{ height: null }, { width: null }],
		},
		select: {
			id: true,
			userId: true,
			provider: true,
			s3Path: true,
			height: true,
			width: true,
		},
		orderBy: { createdAt: "asc" },
	});

	logger.info({ count: media.length }, "Found media missing dimensions");

	if (media.length === 0) {
		logger.info("No media need dimension updates");
		return;
	}

	let updated = 0;
	let failed = 0;

	// Process in batches
	for (let i = 0; i < media.length; i += BATCH_SIZE) {
		const batch = media.slice(i, i + BATCH_SIZE);

		logger.info(
			{
				batch: Math.floor(i / BATCH_SIZE) + 1,
				totalBatches: Math.ceil(media.length / BATCH_SIZE),
			},
			"Processing batch",
		);

		await Promise.allSettled(
			batch.map(async (mediaItem) => {
				try {
					if (!mediaItem.s3Path) {
						logger.warn({ mediaId: mediaItem.id, userId: mediaItem.userId }, "Media has no s3Path");
						return;
					}

					// Download image from S3
					const imageBuffer = await s3.file(mediaItem.s3Path).arrayBuffer();

					const metadata = await new Bun.Image(imageBuffer)
						.metadata()
						.catch(() => ({ height: null, width: null }));

					if (!(metadata.height && metadata.width)) {
						logger.warn(
							{ mediaId: mediaItem.id, userId: mediaItem.userId, metadata },
							"Failed to extract dimensions",
						);
						failed++;
						return;
					}

					if (!DRY_RUN) {
						// Update media with dimensions
						await prisma.media.update({
							where: {
								mediaId: {
									id: mediaItem.id,
									userId: mediaItem.userId,
									provider: mediaItem.provider,
								},
							},
							data: {
								height: metadata.height,
								width: metadata.width,
							},
						});
					}

					logger.debug(
						{
							mediaId: mediaItem.id,
							userId: mediaItem.userId,
							height: metadata.height,
							width: metadata.width,
							dryRun: DRY_RUN,
						},
						"Updated media dimensions",
					);

					updated++;
				} catch (error) {
					logger.error(
						{ error, mediaId: mediaItem.id, userId: mediaItem.userId },
						"Failed to update media dimensions",
					);
					failed++;
				}
			}),
		);
	}

	logger.info(
		{
			total: media.length,
			updated,
			failed,
			dryRun: DRY_RUN,
			batchSize: BATCH_SIZE,
		},
		"Finished media dimensions update",
	);
}

main()
	.catch((error) => {
		logger.error({ error }, "Media dimensions update script failed");
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect().catch((error) => {
			logger.error({ error }, "Failed to disconnect from database");
		});
	});

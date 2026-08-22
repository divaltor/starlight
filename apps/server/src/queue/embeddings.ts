import * as EmbeddingsService from "@starlight/api/services/embeddings";
import { DbNull, env, Prisma, prisma } from "@starlight/utils";
import { Queue, Worker } from "bullmq";
import { logger } from "@/logger";
import { runtime } from "@/services/runtime";
import { redis } from "@/storage";

interface ClassificationJobData {
	photoId: string;
	requestId?: string;
	userId: string;
}

export const embeddingsQueue = new Queue<ClassificationJobData>("embeddings", {
	connection: redis,
	defaultJobOptions: {
		attempts: 5,
		backoff: { type: "exponential", delay: 30_000 },
		removeOnComplete: true,
		removeOnFail: true,
	},
});

export const embeddingsWorker = new Worker<ClassificationJobData>(
	"embeddings",
	async (job) => {
		if (!env.ENABLE_EMBEDDINGS) {
			logger.warn({ jobId: job.id }, "Embeddings skipped: feature disabled");
			return;
		}

		const { photoId, userId, requestId: incomingRequestId } = job.data;
		const requestId = incomingRequestId || Bun.randomUUIDv7();

		if (!(env.ML_BASE_URL && env.ML_API_TOKEN)) {
			logger.warn({ photoId, userId, requestId }, "Embeddings skipped: service not configured");
			return;
		}

		logger.info({ photoId, userId, requestId }, "Generating photo embeddings");

		const photo = await prisma.photo.findUnique({
			where: {
				photoId: { id: photoId, userId },
				classification: { not: DbNull },
			},
			select: {
				s3Url: true,
				classification: true,
			},
		});

		if (!photo) {
			logger.error({ photoId, userId, requestId }, "Photo not found");
			return;
		}

		if (!photo.s3Url) {
			logger.warn({ photoId, userId, requestId }, "Photo is missing an S3 URL");
			throw new Error("Photo has no URL for embeddings");
		}

		const characters = photo.classification?.characters ?? [];
		const tags = photo.classification?.tags ?? [];

		const result = await runtime.runPromise(
			EmbeddingsService.Service.use((s) =>
				s.generate(
					photo.s3Url!,
					characters.length === 0 ? tags : [...characters, ...tags],
					requestId,
				),
			),
		);

		if (!result) {
			logger.error({ photoId, userId, requestId }, "Failed to generate embeddings");
			throw new Error("Embeddings generation failed");
		}

		const textVecStr = `[${result.text.join(",")}]`;
		const imageVecStr = `[${(result.image ?? []).join(",")}]`;

		await prisma.$executeRaw(
			Prisma.sql`UPDATE photos SET tag_vec = ${textVecStr}::vector, image_vec = ${imageVecStr}::vector WHERE id = ${photoId} AND user_id = ${userId}`,
		);

		logger.info({ photoId, userId, requestId }, "Photo embeddings generated");
	},
	{
		connection: redis,
		concurrency: 1,
		autorun: false,
		lockDuration: 1000 * 60 * 5,
	},
);

embeddingsWorker.on("failed", (job) => {
	logger.error(
		{
			err: job?.failedReason,
			jobId: job?.id,
			photoId: job?.data.photoId,
			stack: job?.stacktrace,
			userId: job?.data.userId,
		},
		"Embeddings job failed",
	);
});

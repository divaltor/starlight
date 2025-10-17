import { DbNull, env, prisma, updatePhotoEmbeddings } from "@starlight/utils";
import { Queue, QueueEvents, Worker } from "bullmq";
import { logger } from "@/logger";
import { redis } from "@/storage";

type ClassificationJobData = {
	photoId: string;
	userId: string;
};

type EmbeddingResponse = {
	image: number[] | null;
	text: number[];
};

export const embeddingsQueue = new Queue<ClassificationJobData>("embeddings", {
	connection: redis.options,
	defaultJobOptions: {
		attempts: 5,
		backoff: { type: "exponential", delay: 30_000 }, // 30s, 90s, 270s
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

		const { photoId, userId } = job.data;

		if (!(env.ML_BASE_URL && env.ML_API_TOKEN)) {
			logger.warn(
				{ photoId, userId },
				"Embeddings skipped: service not configured"
			);
			return;
		}

		logger.info(
			{ photoId, userId },
			"Generating embeddings for photo %s for user %s",
			photoId,
			userId
		);

		// Fetch photo record to get URL
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
			logger.error(
				{ photoId, userId },
				"Photo %s not found for user %s",
				photoId,
				userId
			);
			return;
		}

		if (!photo.s3Url) {
			logger.warn({ photoId, userId }, "Photo %s has no s3Url yet", photoId);
			throw new Error("Photo has no URL for embeddings");
		}

		let response: Response;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-API-Token": env.ML_API_TOKEN,
		};

		try {
			response = await fetch(
				new URL("/v1/embeddings", env.ML_BASE_URL).toString(),
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						image: photo.s3Url,
						tags: photo.classification?.tags,
					}),
				}
			);
		} catch (error) {
			logger.error(
				{ photoId, userId, error },
				"Failed request to embeddings service"
			);
			throw error;
		}

		if (!response.ok) {
			const text = await response.text();
			logger.error(
				{ photoId, userId, status: response.status, body: text },
				"Embeddings service error"
			);
			throw new Error(`Classification service error: ${response.status}`);
		}

		let data: EmbeddingResponse;

		try {
			data = await response.json();
		} catch (error) {
			logger.error(
				{ photoId, userId, error },
				"Failed to parse embeddings response"
			);
			throw error;
		}

		await prisma.$queryRawTyped(
			updatePhotoEmbeddings(photoId, userId, data.text, data.image ?? [])
		);

		logger.info({ photoId, userId }, "Photo %s embeddings generated", photoId);
	},
	{
		connection: redis.options,
		concurrency: 2,
		autorun: false,
		lockDuration: 1000 * 60 * 5,
	}
);

embeddingsWorker.on("failed", (job) => {
	logger.error(
		{
			jobId: job?.id,
			photoId: job?.data?.photoId,
			userId: job?.data?.userId,
			error: job?.failedReason,
			stack: job?.stacktrace,
		},
		"Embeddings job failed"
	);
});

const embeddingsEvents = new QueueEvents("embeddings", {
	connection: redis.options,
});

embeddingsEvents.on("completed", ({ jobId }) => {
	logger.debug({ jobId }, "Embeddings job completed");
});

embeddingsEvents.on("failed", ({ jobId, failedReason }) => {
	logger.error({ jobId, failedReason }, "Embeddings job failed");
});

embeddingsEvents.on("added", ({ jobId }) => {
	logger.debug({ jobId }, "Embeddings job added");
});

import { env, prisma } from "@starlight/utils";
import { Queue, QueueEvents, Worker } from "bullmq";
import { logger } from "@/logger";
import { redis } from "@/storage";
import type { Classification } from "@/types";

interface ClassificationJobData {
	photoId: string;
	requestId?: string;
	userId: string;
}

export const classificationQueue = new Queue<ClassificationJobData>("classification", {
	connection: redis,
	defaultJobOptions: {
		attempts: 5,
		backoff: { type: "exponential", delay: 30_000 }, // 30s, 90s, 270s
		removeOnComplete: true,
		removeOnFail: true,
	},
});

export const classificationWorker = new Worker<ClassificationJobData>(
	"classification",
	async (job) => {
		if (!env.ENABLE_CLASSIFICATION) {
			logger.warn({ jobId: job.id }, "Classification skipped: feature disabled");
			return;
		}

		const { photoId, userId, requestId: incomingRequestId } = job.data;
		const requestId = incomingRequestId || Bun.randomUUIDv7();

		if (!(env.ML_BASE_URL && env.ML_API_TOKEN)) {
			logger.warn({ photoId, userId, requestId }, "Classification skipped: service not configured");
			return;
		}

		logger.info(
			{ photoId, userId, requestId },
			"Classifying photo %s for user %s",
			photoId,
			userId,
		);

		// Fetch photo record to get URL
		const photo = await prisma.photo.findUnique({
			where: { photoId: { id: photoId, userId } },
			select: {
				id: true,
				userId: true,
				classification: true,
				s3Url: true,
				s3Path: true,
			},
		});

		if (!photo) {
			logger.error(
				{ photoId, userId, requestId },
				"Photo %s not found for user %s",
				photoId,
				userId,
			);
			return;
		}

		if (!photo.s3Url) {
			logger.warn({ photoId, userId, requestId }, "Photo %s has no s3Url yet", photoId);
			throw new Error("Photo has no URL for classification");
		}

		let response: Response;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-API-Token": env.ML_API_TOKEN,
			"X-Request-Id": requestId,
		};

		try {
			response = await fetch(new URL("/v1/classify", env.ML_BASE_URL).toString(), {
				method: "POST",
				headers,
				body: JSON.stringify({ image: photo.s3Url }),
			});
		} catch (error) {
			logger.error(
				{ photoId, userId, requestId, error },
				"Failed request to classification service",
			);
			throw error;
		}

		if (!response.ok) {
			const text = await response.text();
			logger.error(
				{ photoId, userId, requestId, status: response.status, body: text },
				"Classification service error",
			);
			throw new Error(`Classification service error: ${response.status}`);
		}

		let data: Classification;

		try {
			data = await response.json();
		} catch (error) {
			logger.error(
				{ photoId, userId, requestId, error },
				"Failed to parse classification response",
			);
			throw error;
		}

		await prisma.photo.update({
			where: { photoId: { id: photoId, userId } },
			data: { classification: data },
		});

		logger.info({ photoId, userId, requestId }, "Photo %s classified", photoId);
	},
	{
		connection: redis,
		concurrency: 2,
		autorun: false,
		lockDuration: 1000 * 60 * 5,
	},
);

classificationWorker.on("failed", (job) => {
	logger.error(
		{
			jobId: job?.id,
			photoId: job?.data?.photoId,
			userId: job?.data?.userId,
			error: job?.failedReason,
			stack: job?.stacktrace,
		},
		"Classification job failed",
	);
});

const classificationEvents = new QueueEvents("classification", {
	connection: redis,
});

classificationEvents.on("completed", ({ jobId }) => {
	logger.debug({ jobId }, "Classification job completed");
});

classificationEvents.on("failed", ({ jobId, failedReason }) => {
	logger.error({ jobId, failedReason }, "Classification job failed");
});

classificationEvents.on("added", ({ jobId }) => {
	logger.debug({ jobId }, "Classification job added");
});

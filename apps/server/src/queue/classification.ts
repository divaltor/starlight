import { env, prisma } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import { Queue, Worker } from "bullmq";
import { logger } from "@/logger";
import { embeddingsQueue } from "@/queue/embeddings";
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
		backoff: { type: "exponential", delay: 30_000 },
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

		logger.info({ photoId, userId, requestId }, "Classifying photo");

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
			logger.error({ photoId, userId, requestId }, "Photo not found");
			return;
		}

		if (!photo.s3Url) {
			logger.warn({ photoId, userId, requestId }, "Photo is missing an S3 URL");
			throw new Error("Photo has no URL for classification");
		}

		let response: Response;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-API-Token": env.ML_API_TOKEN,
			"X-Request-Id": requestId,
		};

		try {
			response = await http(new URL("/v1/classify", env.ML_BASE_URL).toString(), {
				method: "post",
				headers,
				json: { image: photo.s3Url },
			});
		} catch (error) {
			logger.error(
				{ err: error, photoId, userId, requestId },
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
				{ err: error, photoId, userId, requestId },
				"Failed to parse classification response",
			);
			throw error;
		}

		await prisma.photo.update({
			where: { photoId: { id: photoId, userId } },
			data: { classification: data },
		});

		await embeddingsQueue.add(
			`embed-${photoId}`,
			{ photoId, userId, requestId },
			{
				jobId: `embed-${photoId}-${userId}`,
				deduplication: { id: `embed-${photoId}-${userId}` },
			},
		);

		logger.info({ photoId, userId, requestId }, "Photo classified");
	},
	{
		connection: redis,
		concurrency: 1,
		autorun: false,
		lockDuration: 1000 * 60 * 5,
	},
);

classificationWorker.on("failed", (job) => {
	logger.error(
		{
			err: job?.failedReason,
			jobId: job?.id,
			photoId: job?.data.photoId,
			stack: job?.stacktrace,
			userId: job?.data.userId,
		},
		"Classification job failed",
	);
});

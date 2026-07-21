import { Absurd } from "absurd-sdk";
import { env, prisma } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import { logger } from "@/logger";
import { QUEUES, RETRY } from "@/queue/absurd";
import { embeddingsApp } from "@/queue/embeddings";
import type { Classification } from "@/types";

interface ClassificationJobData {
	photoId: string;
	requestId?: string;
	userId: string;
}

export const classificationApp = new Absurd({
	db: env.DATABASE_URL,
	log: {
		log: logger.debug.bind(logger),
		info: logger.info.bind(logger),
		warn: logger.warn.bind(logger),
		error: logger.error.bind(logger),
	},
	queueName: QUEUES.classification,
});

classificationApp.registerTask<ClassificationJobData>(
	{ name: "classification" },
	async (params, ctx) => {
		if (!env.ENABLE_CLASSIFICATION) {
			logger.warn({ jobId: ctx.taskID }, "Classification skipped: feature disabled");
			return;
		}

		const { photoId, userId, requestId: incomingRequestId } = params;
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

		await embeddingsApp.spawn(
			"embeddings",
			{ photoId, userId, requestId },
			{
				idempotencyKey: `embed-${photoId}-${userId}`,
				maxAttempts: 5,
				retryStrategy: RETRY.embeddings,
			},
		);

		logger.info({ photoId, userId, requestId }, "Photo classified");
	},
);

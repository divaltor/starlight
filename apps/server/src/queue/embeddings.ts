import { Absurd } from "absurd-sdk";
import { DbNull, env, Prisma, prisma } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import { logger } from "@/logger";
import { QUEUES } from "@/queue/absurd";

interface ClassificationJobData {
	photoId: string;
	requestId?: string;
	userId: string;
}

interface EmbeddingResponse {
	image: number[] | null;
	text: number[];
}

export const embeddingsApp = new Absurd({
	db: env.DATABASE_URL,
	log: {
		log: logger.debug.bind(logger),
		info: logger.info.bind(logger),
		warn: logger.warn.bind(logger),
		error: logger.error.bind(logger),
	},
	queueName: QUEUES.embeddings,
});

embeddingsApp.registerTask<ClassificationJobData>({ name: "embeddings" }, async (params, ctx) => {
	if (!env.ENABLE_EMBEDDINGS) {
		logger.warn({ jobId: ctx.taskID }, "Embeddings skipped: feature disabled");
		return;
	}

	const { photoId, userId, requestId: incomingRequestId } = params;
	const requestId = incomingRequestId || Bun.randomUUIDv7();

	if (!(env.ML_BASE_URL && env.ML_API_TOKEN)) {
		logger.warn({ photoId, userId, requestId }, "Embeddings skipped: service not configured");
		return;
	}

	logger.info(
		{ photoId, userId, requestId },
		"Generating embeddings for photo %s for user %s",
		photoId,
		userId,
	);

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
		logger.error({ photoId, userId, requestId }, "Photo %s not found for user %s", photoId, userId);
		return;
	}

	if (!photo.s3Url) {
		logger.warn({ photoId, userId, requestId }, "Photo %s has no s3Url yet", photoId);
		throw new Error("Photo has no URL for embeddings");
	}

	let response: Response;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-API-Token": env.ML_API_TOKEN,
		"X-Request-Id": requestId,
	};

	try {
		const characters = photo.classification?.characters ?? [];
		const tags = photo.classification?.tags ?? [];

		response = await http(new URL("/v1/embeddings", env.ML_BASE_URL).toString(), {
			method: "post",
			headers,
			json: {
				image: photo.s3Url,
				tags: characters.length === 0 ? tags : [...characters, ...tags],
			},
		});
	} catch (error) {
		logger.error({ photoId, userId, requestId, error }, "Failed request to embeddings service");
		throw error;
	}

	if (!response.ok) {
		const text = await response.text();
		logger.error(
			{ photoId, userId, requestId, status: response.status, body: text },
			"Embeddings service error",
		);
		throw new Error(`Classification service error: ${response.status}`);
	}

	let data: EmbeddingResponse;

	try {
		data = await response.json();
	} catch (error) {
		logger.error({ photoId, userId, requestId, error }, "Failed to parse embeddings response");
		throw error;
	}

	const textVecStr = `[${data.text.join(",")}]`;
	const imageVecStr = `[${(data.image ?? []).join(",")}]`;

	await prisma.$executeRaw(
		Prisma.sql`UPDATE photos SET tag_vec = ${textVecStr}::vector, image_vec = ${imageVecStr}::vector WHERE id = ${photoId} AND user_id = ${userId}`,
	);

	logger.info({ photoId, userId, requestId }, "Photo %s embeddings generated", photoId);
});

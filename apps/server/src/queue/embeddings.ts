import { Absurd } from "absurd-sdk";
import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { DbNull, env, Prisma, prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { QUEUES } from "@/queue/absurd";
import { runtime } from "@/services/runtime";

interface ClassificationJobData {
	photoId: string;
	requestId?: string;
	userId: string;
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

	logger.info({ photoId, userId, requestId }, "Photo %s embeddings generated", photoId);
});

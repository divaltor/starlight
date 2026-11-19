import { Prisma, prisma } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import { Queue, Worker } from "bullmq";
import { Schema } from "effect";
import env from "@/env";
import { logger } from "@/logger";
import { embeddingsQueue } from "@/queue/embeddings";
import { PhotoJobData } from "@/queue/photo-job";
import { redis } from "@/storage";
import { Classification } from "@/types";

// Bounds the classification request including the response body (ky's
// `timeout` only covers time-to-headers), so a stalled ML service fails the
// job for retry instead of hanging the worker.
const CLASSIFICATION_TIMEOUT_MS = 15_000;

const ClassifyResponse = Schema.Struct({
  ...Classification.fields,
  embeddings: Schema.optional(
    Schema.Struct({
      image: Schema.NullOr(Schema.Array(Schema.Number)),
      text: Schema.Array(Schema.Number),
    }),
  ),
});

export const classificationQueue = new Queue<PhotoJobData>("classification", {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

export const classificationWorker = new Worker<PhotoJobData>(
  "classification",
  async (job) => {
    if (!env.ENABLE_CLASSIFICATION) {
      logger.warn({ jobId: job.id }, "Classification skipped: feature disabled");

      return;
    }

    const { photoId, userId, requestId: incomingRequestId } = Schema.decodeUnknownSync(PhotoJobData)(job.data);

    const requestId =
      incomingRequestId === undefined || incomingRequestId === "" ? Bun.randomUUIDv7() : incomingRequestId;

    if (
      env.ML_BASE_URL === undefined ||
      env.ML_BASE_URL === "" ||
      env.ML_API_TOKEN === undefined ||
      env.ML_API_TOKEN === ""
    ) {
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

    if (photo.s3Url === undefined || photo.s3Url === "") {
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
        json: { image: photo.s3Url, include_embeddings: env.ENABLE_EMBEDDINGS },
        signal: AbortSignal.timeout(CLASSIFICATION_TIMEOUT_MS),
      });
    } catch (error) {
      logger.error({ err: error, photoId, userId, requestId }, "Failed request to classification service");
      throw error;
    }

    if (!response.ok) {
      const text = await response.text();
      logger.error({ photoId, userId, requestId, status: response.status, body: text }, "Classification service error");
      throw new Error(`Classification service error: ${response.status}`);
    }

    let parsed: typeof ClassifyResponse.Type;

    try {
      parsed = Schema.decodeUnknownSync(ClassifyResponse)(await response.json());
    } catch (error) {
      logger.error({ err: error, photoId, userId, requestId }, "Failed to parse classification response");
      throw error;
    }

    const classification: Classification = {
      aesthetic: parsed.aesthetic,
      characters: parsed.characters,
      nsfw: parsed.nsfw,
      style: parsed.style,
      tags: parsed.tags,
      tagger: parsed.tagger,
    };

    await prisma.photo.update({
      where: { photoId: { id: photoId, userId } },
      data: { classification },
    });

    if (parsed.embeddings?.image !== undefined && parsed.embeddings.image !== null) {
      const textVecStr = `[${parsed.embeddings.text.join(",")}]`;
      const imageVecStr = `[${parsed.embeddings.image.join(",")}]`;

      await prisma.$executeRaw(
        Prisma.sql`UPDATE photos SET tag_vec = ${textVecStr}::vector, image_vec = ${imageVecStr}::vector WHERE id = ${photoId} AND user_id = ${userId}`,
      );
      logger.info({ photoId, userId, requestId }, "Photo classified and embedded");

      return;
    }

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
    concurrency: 2,
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

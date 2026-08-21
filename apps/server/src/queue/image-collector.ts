import { prisma } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Queue, Worker } from "bullmq";
import UserAgent from "user-agents";
import { logger } from "@/logger";
import { classificationQueue } from "@/queue/classification";
import { findDuplicatesByImageContent } from "@/services/duplicate-detection";
import { calculatePerceptualHash } from "@/services/image";
import { redis, s3 } from "@/storage";

export interface ImageCollectorJobData {
	tweet: Tweet;
	// From database
	userId: string;
}

export const imagesQueue = new Queue<ImageCollectorJobData>("images-collector", {
	connection: redis,
	defaultJobOptions: {
		attempts: 3,
		backoff: { type: "exponential", delay: 10_000 },
	},
});

export const imagesWorker = new Worker<ImageCollectorJobData>(
	"images-collector",
	async (job) => {
		const { tweet, userId } = job.data;

		// Tweet guaranteed to have IDs, fucking types
		const id = tweet.id!;

		logger.info({ tweetId: tweet.id, userId }, "Processing tweet");

		if (tweet.photos.length === 0) {
			logger.debug({ tweetId: tweet.id, userId }, "Tweet has no photos, skipping job");
			return;
		}

		const userAgent = new UserAgent();

		// We can safely update Tweet record here, because we created Tweet object in scrapper queue
		const tweetRecord = await prisma.tweet.update({
			where: { tweetId: { userId, id } },
			data: {
				tweetData: tweet,
				photos: {
					createMany: {
						data: tweet.photos.map((photo) => ({
							id: photo.id,
							originalUrl: photo.url,
						})),
						// Guaranteed that if we'll restart a job then we won't have additional photos in Tweet relation
						skipDuplicates: true,
					},
				},
			},
			include: {
				photos: true,
			},
		});

		logger.info(
			{ tweetId: tweet.id, userId, photos: tweetRecord.photos.length },
			"Tweet upserted with photos",
		);

		const refreshedPhotoIds = new Set<string>();
		const refreshTimestamp = new Date();

		for (const photo of tweetRecord.photos) {
			if (photo.s3Path && photo.perceptualHash) {
				logger.debug(
					{
						tweetId: tweet.id,
						photoId: photo.id,
						userId,
					},
					"Photo already downloaded; skipping",
				);
				continue;
			}

			const response = await http(photo.originalUrl, {
				headers: {
					"User-Agent": userAgent.toString(),
				},
			});

			if (!response.ok) {
				logger.error(
					{
						tweetId: tweet.id,
						photoUrl: photo.originalUrl,
						status: response.status,
						userId,
					},
					"Failed to fetch photo",
				);
				throw new Error(`Failed to fetch photo ${photo.originalUrl}`);
			}

			const imageBuffer = await response.arrayBuffer();

			const similarPhotos = await findDuplicatesByImageContent(imageBuffer);

			if (similarPhotos.length > 0) {
				const existingPhoto = similarPhotos.find((similarPhoto) => similarPhoto.userId === userId);

				if (existingPhoto && !refreshedPhotoIds.has(existingPhoto.id)) {
					await prisma.photo.update({
						where: { photoId: { id: existingPhoto.id, userId } },
						data: { updatedAt: refreshTimestamp },
					});
					refreshedPhotoIds.add(existingPhoto.id);
				}

				logger.info(
					{
						tweetId: tweet.id,
						photoId: photo.id,
						userId,
						refreshedPhotoId: existingPhoto?.id,
						similarPhotos,
					},
					"Found similar photos, skipping saving photo",
				);
			} else {
				const extension = photo.originalUrl.split(".").pop() ?? "jpg";

				const photoName = `${photo.externalId}.${extension}`;

				const [, hash, metadata] = await Promise.all([
					s3.write(`media/${photoName}`, imageBuffer),
					calculatePerceptualHash(imageBuffer),
					new Bun.Image(imageBuffer).metadata().catch(() => ({ height: null, width: null })),
				]);

				await prisma.photo.update({
					where: { photoId: { id: photo.id, userId } },
					data: {
						perceptualHash: hash,
						s3Path: `media/${photoName}`,
						height: metadata.height,
						width: metadata.width,
					},
				});

				// Enqueue classification job
				try {
					await classificationQueue.add(
						`classify-${photo.id}`,
						{ photoId: photo.id, userId },
						{
							jobId: `classify-${photo.id}-${userId}`,
							deduplication: { id: `classify-${photo.id}-${userId}` },
						},
					);
				} catch (error) {
					logger.error(
						{ err: error, photoId: photo.id, userId },
						"Failed to enqueue classification job",
					);
				}

				logger.info(
					{
						tweetId: tweet.id,
						photoId: photo.id,
						userId,
					},
					"Photo saved to S3",
				);
			}
		}
	},
	{
		connection: redis,
		concurrency: 3,
		removeOnComplete: { age: 60 * 60, count: 1000 },
		removeOnFail: { age: 60 * 60 * 24, count: 5000 },
		autorun: false,
	},
);

imagesWorker.on("failed", (job) => {
	logger.error(
		{ err: job?.failedReason, jobId: job?.id, stack: job?.stacktrace },
		"Image collector job failed",
	);
});

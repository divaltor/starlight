import { logger } from "@/logger";
import { calculatePerceptualHash } from "@/services/image";
import { redis, s3 } from "@/storage";
import { prisma } from "@/storage";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Queue, QueueEvents, Worker } from "bullmq";
import UserAgent from "user-agents";

export const imagesQueue = new Queue<ImageCollectorJobData>(
	"images-collector",
	{
		connection: redis,
		defaultJobOptions: {
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 10000, // 10 seconds
			},
		},
	},
);

interface ImageCollectorJobData {
	tweet: Tweet;
	// From database
	userId: string;
}

export const imagesWorker = new Worker<ImageCollectorJobData>(
	"images-collector",
	async (job) => {
		const { tweet, userId } = job.data;

		logger.info(
			{ tweetId: tweet.id, userId },
			"Processing tweet %s for user %s",
			tweet.id,
			userId,
		);

		if (!tweet.id) {
			logger.error(
				{ tweetId: tweet.id, userId },
				"Tweet ID is required, skipping job",
			);
			return;
		}

		if (tweet.photos.length === 0) {
			logger.debug(
				{ tweetId: tweet.id, userId },
				"Tweet has no photos, skipping job",
			);
			return;
		}

		const userAgent = new UserAgent();

		// We can safely update Tweet record here, because we created Tweet object in scrapper queue
		const tweetRecord = await prisma.tweet.update({
			where: { tweetId: { userId, id: tweet.id } },
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
			"Tweet %s for user %s upserted with %s photos",
			tweet.id,
			userId,
			tweetRecord.photos.length,
		);

		for (const photo of tweetRecord.photos) {
			if (photo.s3Path && photo.perceptualHash) {
				logger.debug(
					{
						tweetId: tweet.id,
						photoId: photo.id,
						userId,
					},
					"Photo %s already downloaded, skipping",
					photo.id,
				);
				continue;
			}

			const response = await fetch(photo.originalUrl, {
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
					"Failed to fetch photo %s for tweet %s",
				);
				throw new Error(`Failed to fetch photo ${photo.originalUrl}`);
			}

			const extension = photo.originalUrl.split(".").pop() ?? "jpg";

			const photoName = `${photo.externalId}.${extension}`;

			const imageBuffer = await response.arrayBuffer();

			const [, hash] = await Promise.all([
				s3.write(`media/${photoName}`, imageBuffer),
				calculatePerceptualHash(imageBuffer),
			]);

			await prisma.photo.update({
				where: { photoId: { id: photo.id, userId } },
				data: {
					perceptualHash: hash,
					s3Path: `media/${photoName}`,
				},
			});

			logger.info(
				{
					tweetId: tweet.id,
					photoId: photo.id,
					userId,
				},
				"Tweet %s photos are saved to S3 for user %s",
				tweet.id,
				userId,
			);
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
		{ jobId: job?.id, error: job?.failedReason, stack: job?.stacktrace },
		"Image collector job failed",
	);
});

const imageCollectorEvents = new QueueEvents("images-collector", {
	connection: redis,
});

imageCollectorEvents.on("completed", ({ jobId }) => {
	logger.debug({ jobId }, "Image collector job completed");
});

imageCollectorEvents.on("failed", ({ jobId, failedReason }) => {
	logger.error({ jobId, failedReason }, "Image collector job failed");
});

imageCollectorEvents.on("added", ({ jobId }) => {
	logger.debug({ jobId }, "Image collector job added");
});

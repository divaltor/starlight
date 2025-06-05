import { logger } from "@/logger";
import { calculatePerceptualHash } from "@/services/image";
import { prisma, redis, s3 } from "@/storage";
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

		if (!tweet.id) {
			logger.error({ tweet }, "Tweet ID is required, skipping job");
			return;
		}

		const userAgent = new UserAgent();

		// We can safely update Tweet record here,
		// because it's not possible to have multiple tweets with the same ID
		const tweetRecord = await prisma.tweet.upsert({
			where: { tweetId: { userId, id: tweet.id } },
			create: {
				id: tweet.id,
				userId,
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
			update: {
				tweetData: tweet,
			},
			include: {
				photos: true,
			},
		});

		for (const photo of tweetRecord.photos) {
			const response = await fetch(photo.originalUrl, {
				headers: {
					"User-Agent": userAgent.toString(),
				},
			});

			logger.debug(
				{
					photoUrl: photo.originalUrl,
					status: response.status,
					statusText: response.statusText,
				},
				"Response for photo",
			);

			if (!response.ok) {
				throw new Error(`Failed to fetch photo ${photo.originalUrl}`);
			}

			const extension = photo.originalUrl.split(".").pop() ?? "jpg";

			const photoName = `${photo.externalId}.${extension}`;

			const imageBuffer = await response.arrayBuffer();

			const [, hash] = await Promise.all([
				s3.write(`media/${photoName}`, imageBuffer),
				calculatePerceptualHash(imageBuffer),
			]);

			logger.debug({ hash }, "Calculated perceptual hash");

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
					photoUrl: photo.originalUrl,
					s3Url: photo.s3Url,
				},
				"Photo saved from Twitter",
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
	logger.info({ jobId }, "Image collector job completed");
});

imageCollectorEvents.on("failed", ({ jobId, failedReason }) => {
	logger.error({ jobId, failedReason }, "Image collector job failed");
});

imageCollectorEvents.on("added", ({ jobId }) => {
	logger.info({ jobId }, "Image collector job added");
});

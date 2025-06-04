import { logger } from "@/logger";
import { calculatePerceptualHash, hashToInt } from "@/services/image";
import { imageUrl, perceptualHashKey, redis, s3, tweetKey } from "@/storage";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Queue, QueueEvents, Worker } from "bullmq";
import { typeidUnboxed } from "typeid-js";
import UserAgent from "user-agents";

const imagesQueue = new Queue("images-collector", {
	connection: redis,
	defaultJobOptions: {
		attempts: 3,
		backoff: {
			type: "exponential",
			delay: 10000, // 10 seconds
		},
	},
});

interface ImageCollectorJobData {
	tweet: Tweet;
	telegram: {
		userId: string;
		chatId: string;
	};
}

interface S3Photo {
	id: string;
	s3Url: string;
	originalUrl: string;
	status: "ready" | "deleted";
	perceptualHash: string;
}

interface RedisTweet {
	tweet: Tweet;
	photos: S3Photo[];
	metadata: {
		createdAt: Date;
	};
	telegramUserId: string;
}

const imagesWorker = new Worker(
	"images-collector",
	async (job) => {
		const { tweet, telegram } = job.data as ImageCollectorJobData;

		// Can't happend, used only to fix linter errors
		if (!tweet.id) {
			logger.error({ tweet }, "Tweet ID is required, skipping job");
			return;
		}

		const userAgent = new UserAgent();

		const pipeline = redis.multi();

		const now = new Date();

		pipeline.call(
			"JSON.SET",
			tweetKey(telegram.userId, tweet.id),
			"$",
			JSON.stringify({
				tweet: tweet,
				photos: [],
				metadata: { createdAt: now },
			}),
		);

		for (const photo of tweet.photos) {
			const response = await fetch(photo.url, {
				headers: {
					"User-Agent": userAgent.toString(),
				},
			});

			logger.debug(
				{
					photoUrl: photo.url,
					status: response.status,
					statusText: response.statusText,
				},
				"Response for photo",
			);

			if (!response.ok) {
				throw new Error(`Failed to fetch photo ${photo.url}`);
			}

			const extension = photo.url.split(".").pop() ?? "jpg";

			const photoId = typeidUnboxed();
			const photoName = `${photoId}.${extension}`;

			const imageBuffer = await response.arrayBuffer();

			const [, hash] = await Promise.all([
				s3.write(`media/${photoName}`, imageBuffer),
				calculatePerceptualHash(imageBuffer),
			]);

			const intHash = hashToInt(hash);

			logger.debug({ hash, intHash }, "Calculated perceptual hash");

			pipeline.call(
				"JSON.ARRAPPEND",
				tweetKey(telegram.userId, tweet.id),
				"$.photos",
				JSON.stringify({
					id: photoId,
					s3Url: imageUrl(photoName),
					originalUrl: photo.url,
					status: "ready",
					perceptualHash: intHash,
				}),
			);

			pipeline.zadd(
				perceptualHashKey(telegram.userId),
				intHash,
				`${intHash}:${tweet.id}:${photoId}`,
			);

			logger.info(
				{
					tweetId: tweet.id,
					photoUrl: photo.url,
					s3Url: imageUrl(photoName),
				},
				"Photo saved from Twitter",
			);
		}

		await pipeline.exec();
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

export { imagesQueue, imagesWorker, type RedisTweet, type S3Photo };

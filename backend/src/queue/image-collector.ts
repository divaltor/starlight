import { logger } from "@/logger";
import { imageUrl, redis, s3, timelineKey, tweetKey } from "@/storage";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Queue, Worker } from "bullmq";
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

interface RedisTweet {
	tweet: Tweet;
	photos: string[];
	metadata: {
		createdAt: Date;
	};
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

			const photoName = `${crypto.randomUUID()}.${extension}`;

			await s3.write(`${telegram.userId}/${tweet.id}/${photoName}`, response);

			pipeline.call(
				"JSON.ARRAPPEND",
				tweetKey(telegram.userId, tweet.id),
				"$.photos",
				JSON.stringify(photoName),
			);

			logger.info(
				{
					tweetId: tweet.id,
					photoUrl: photo.url,
					s3Url: imageUrl(telegram.userId, tweet.id, photoName),
				},
				"Photo saved from Twitter",
			);
		}

		pipeline.zadd(
			timelineKey(telegram.userId),
			now.getTime() + Math.random() * 1000,
			`${tweet.id}`,
		);

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

export { imagesQueue, imagesWorker, type RedisTweet };

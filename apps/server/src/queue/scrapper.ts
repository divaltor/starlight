import { logger } from "@/logger";
import { imagesQueue } from "@/queue/image-collector";
import { Cookies, prisma, redis } from "@/storage";
import type { User } from "@/utils";
import {
	ApiError,
	AuthenticationError,
	type QueryTweetsResponse,
	Scraper,
} from "@the-convocation/twitter-scraper";
import { Queue, QueueEvents, Worker } from "bullmq";

export const scrapperQueue = new Queue<ScrapperJobData>("feed-scrapper", {
	connection: redis,
	defaultJobOptions: {
		attempts: 3,
		// It will be retried in 2.5 minutes, 7.5 minutes, 22.5 minutes
		backoff: {
			type: "exponential",
			delay: 150000, // 2.5 minutes
		},
	},
});

interface ScrapperJobData {
	userId: string;
	count: number;
	limit: number;
	cursor?: string;
}

export const scrapperWorker = new Worker<ScrapperJobData>(
	"feed-scrapper",
	async (job) => {
		const { userId } = job.data;

		logger.info(
			{ userId, jobData: job.data },
			"Scraping timeline for user %s, page %s",
			userId,
			job.data.cursor,
		);

		let user: User;

		try {
			user = await prisma.user.findUniqueOrThrow({
				where: {
					id: userId,
				},
			});
		} catch (error) {
			logger.error({ userId, error }, "User not found");
			throw error;
		}

		const user_cookies = await redis.get(`user:cookies:${user.telegramId}`);

		if (!user_cookies) {
			logger.error({ userId }, "User cookies not found");
			throw new Error("User cookies not found");
		}

		const cookies = Cookies.fromJSON(user_cookies);

		const twid = cookies.userId();

		if (!twid) {
			logger.error({ userId }, "User cookies not found");
			throw new Error("User cookies not found");
		}

		const scrapper = new Scraper();
		await scrapper.setCookies(cookies.toString().split(";"));

		let timeline: QueryTweetsResponse;

		try {
			timeline = await scrapper.fetchLikedTweets(twid, 200, job.data.cursor);
		} catch (error) {
			logger.error(
				{
					userId,
					error:
						error instanceof ApiError
							? {
									status: error.response.status,
									message: error.response.statusText,
								}
							: error instanceof AuthenticationError
								? error.message
								: error,
				},
				"Unable to fetch timeline for user %s",
				userId,
			);

			throw error;
		}

		logger.info(
			{
				userId,
				cursor: job.data.cursor,
				tweets: timeline.tweets.length,
			},
			"Scraped timeline for user %s, page %s",
			userId,
			job.data.cursor,
		);

		const CONSECUTIVE_THRESHOLD = 15;

		// Step 1: Batch check existing tweets
		const tweetIds = timeline.tweets
			.map((tweet) => tweet.id)
			.filter((id) => id !== undefined);

		const existingTweetMap = new Map(
			(
				await prisma.tweet.findMany({
					where: { userId, id: { in: tweetIds } },
					select: { id: true, createdAt: true },
				})
			).map((tweet) => [tweet.id, tweet.createdAt]),
		);

		// Step 2: Process tweets and build batch operations
		const newTweets: Array<{ id: string; userId: string; tweetData: any }> = [];
		const updatedTweets: Array<{ id: string; tweetData: any }> = [];
		const tweetsToQueue: Array<{
			name: string;
			data: { tweet: any; userId: string };
			opts: any;
		}> = [];

		let consecutiveKnownTweets = 0;
		let newTweetsInBatch = 0;

		for (const tweet of timeline.tweets) {
			if (!tweet.id) continue;

			const isNewTweet = !existingTweetMap.has(tweet.id);

			if (isNewTweet) {
				consecutiveKnownTweets = 0;
				newTweetsInBatch++;
				newTweets.push({
					id: tweet.id,
					userId,
					tweetData: tweet,
				});
			} else {
				consecutiveKnownTweets++;
				updatedTweets.push({
					id: tweet.id,
					tweetData: tweet,
				});
			}

			// Only queue tweets with photos for image processing
			if (tweet.photos && tweet.photos.length > 0) {
				tweetsToQueue.push({
					name: `post-${tweet.id}`,
					data: {
						tweet,
						userId,
					},
					opts: {
						deduplication: {
							id: `scrapper-${userId}-${tweet.id}`,
						},
					},
				});
			}

			// Stop if we've seen too many consecutive known tweets
			if (consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD) {
				logger.info(
					{
						userId,
						consecutiveKnownTweets,
						newTweetsInBatch,
						totalProcessed: timeline.tweets.indexOf(tweet) + 1,
					},
					"Stopping scrape: found %d consecutive known tweets",
					consecutiveKnownTweets,
				);
				break;
			}
		}

		// Step 3: Execute batch operations in transaction
		await prisma.$transaction(async (tx) => {
			// Batch create new tweets
			if (newTweets.length > 0) {
				await tx.tweet.createMany({
					data: newTweets,
					skipDuplicates: true,
				});
			}

			// Batch update existing tweets
			if (updatedTweets.length > 0) {
				await Promise.all(
					updatedTweets.map((tweet) =>
						tx.tweet.update({
							where: { tweetId: { userId, id: tweet.id } },
							data: { tweetData: tweet.tweetData },
						}),
					),
				);
			}
		});

		// Queue image processing jobs for tweets with photos
		if (tweetsToQueue.length > 0) {
			await imagesQueue.addBulk(tweetsToQueue);
		}

		job.data.count += timeline.tweets.length;

		// Stop if we hit consecutive threshold or other limits
		if (
			consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD ||
			job.data.count >= job.data.limit ||
			!timeline.next
		) {
			logger.info(
				{
					userId,
					count: job.data.count,
					limit: job.data.limit,
					consecutiveKnownTweets,
					newTweetsInBatch,
					reason:
						consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD
							? "consecutive_threshold"
							: job.data.count >= job.data.limit
								? "count_limit"
								: "no_next_cursor",
				},
				"Stopping scrape job",
			);
			return;
		}

		await scrapperQueue.add(
			"feed-scrapper",
			{
				userId,
				count: job.data.count,
				limit: job.data.limit,
				cursor: timeline.next,
			},
			{
				delay: 1000 * 60 * 1, // 1 minute
				deduplication: {
					id: `scrapper-${userId}-${timeline.next}`,
				},
			},
		);

		logger.info(
			{ userId, count: job.data.count, limit: job.data.limit },
			"Scraping next page",
		);
	},
	{
		connection: redis,
		concurrency: 1,
		autorun: false,
		removeOnComplete: { age: 60 * 60 * 24, count: 100 },
		removeOnFail: { age: 60 * 60 * 24 * 7, count: 50 },
	},
);

const scrapperEvents = new QueueEvents("feed-scrapper", {
	connection: redis,
});

scrapperEvents.on("completed", ({ jobId }) => {
	logger.debug({ jobId }, "Scrapper job completed");
});

scrapperEvents.on("failed", ({ jobId, failedReason }) => {
	logger.error({ jobId, failedReason }, "Scrapper job failed");
});

scrapperEvents.on("added", ({ jobId }) => {
	logger.debug({ jobId }, "Scrapper job added");
});

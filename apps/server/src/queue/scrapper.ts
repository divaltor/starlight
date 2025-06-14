import { logger } from "@/logger";
import { imagesQueue } from "@/queue/image-collector";
import { Cookies, prisma, redis } from "@/storage";
import {
	ApiError,
	AuthenticationError,
	type QueryTweetsResponse,
	Scraper,
} from "@the-convocation/twitter-scraper";
import { Queue, Worker } from "bullmq";

export const scrapperQueue = new Queue<ScrapperJobData>("feed-scrapper", {
	connection: redis,
	defaultJobOptions: {
		attempts: 3,
		// It will be retried in 5 minutes, 15 minutes, 70 minutes
		backoff: {
			type: "exponential",
			delay: 300000, // 5 minutes
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

		const user = await prisma.user.findUniqueOrThrow({
			where: {
				id: userId,
			},
		});

		const user_cookies = await redis.get(`user:cookies:${user.telegramId}`);

		if (!user_cookies) {
			throw new Error("User cookies not found");
		}

		const cookies = Cookies.fromJSON(user_cookies);

		const twid = cookies.userId();

		if (!twid) {
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
		let consecutiveKnownTweets = 0;
		let newTweetsInBatch = 0;
		const tweetsToQueue: Array<{ name: string; data: { tweet: any; userId: string }; opts: any }> = [];

		for (const tweet of timeline.tweets) {
			if (!tweet.id) continue;

			// Always store tweet data (even without photos) for reliable tracking
			const tweetRecord = await prisma.tweet.upsert({
				where: { tweetId: { userId, id: tweet.id } },
				create: {
					id: tweet.id,
					userId,
					tweetData: tweet,
				},
				update: {
					tweetData: tweet,
				},
				select: {
					createdAt: true,
				},
			});

			// Check if this tweet was created in this scrape session (within last minute)
			const isNewTweet = tweetRecord.createdAt > new Date(Date.now() - 60000);

			if (isNewTweet) {
				consecutiveKnownTweets = 0;
				newTweetsInBatch++;
			} else {
				consecutiveKnownTweets++;
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
					reason: consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD 
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

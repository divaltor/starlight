import { logger } from "@/server/logger";
import { imagesQueue } from "@/server/queue/image-collector";
import { Cookies, prisma, redis } from "@/server/storage";
import {
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
				{ userId, error },
				"Error scraping timeline for user %s",
				userId,
			);
			throw error;
		}

		logger.info(
			{
				userId,
				timeline,
				cursor: job.data.cursor,
				tweets: timeline.tweets.length,
			},
			"Scraped timeline for user %s, page %s",
			userId,
			job.data.cursor,
		);

		await imagesQueue.addBulk(
			timeline.tweets.map((tweet) => ({
				name: `post-${tweet.id}`,
				data: {
					tweet,
					userId,
				},
			})),
		);

		job.data.count += timeline.tweets.length;

		if (job.data.count >= job.data.limit || !timeline.next) {
			logger.info(
				{ userId, count: job.data.count, limit: job.data.limit },
				"Reached limit, stopping job",
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

import { CookieEncryption } from "@starlight/crypto";
import type { User } from "@starlight/utils";
import { env, prisma } from "@starlight/utils";
import { Scraper } from "@the-convocation/twitter-scraper";
import type { QueryTweetsResponse, Tweet } from "@the-convocation/twitter-scraper";
import { Queue, Worker } from "bullmq";
import { bot } from "@/bot";
import { logger } from "@/logger";
import { imagesQueue } from "@/queue/image-collector";
import { Cookies, redis } from "@/storage";

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);

export interface ScrapperJobData {
	count: number;
	cursor?: string;
	force?: boolean;
	limit: number;
	userId: string;
}

export const FEED_SCRAPPER_QUEUE = "feed-scrapper";

export const scrapperQueue = new Queue<ScrapperJobData>(FEED_SCRAPPER_QUEUE, {
	connection: redis,
	defaultJobOptions: {
		attempts: 3,
		backoff: { type: "exponential", delay: 150_000 },
		removeOnComplete: { age: 60 * 60 * 24, count: 2000 },
		removeOnFail: { age: 60 * 60 * 24, count: 2000 },
	},
});

const CONSECUTIVE_THRESHOLD = 15;

interface ScrapeBatchResult {
	consecutiveKnownTweets: number;
	newTweets: {
		id: string;
		userId: string;
		tweetData: Tweet;
	}[];
	newTweetsInBatch: number;
	tweetsToQueue: { tweet: Tweet; userId: string }[];
	updatedTweets: { id: string; tweetData: Tweet }[];
}

function collectTimelineTweets(
	tweets: Tweet[],
	existingTweetMap: Map<string, Date>,
	userId: string,
	force = false,
): ScrapeBatchResult {
	const result: ScrapeBatchResult = {
		consecutiveKnownTweets: 0,
		newTweets: [],
		newTweetsInBatch: 0,
		tweetsToQueue: [],
		updatedTweets: [],
	};

	for (const [index, tweet] of tweets.entries()) {
		if (tweet.id) {
			const isNewTweet = !existingTweetMap.has(tweet.id);

			if (isNewTweet) {
				result.consecutiveKnownTweets = 0;
				result.newTweetsInBatch++;
				result.newTweets.push({
					id: tweet.id,
					userId,
					tweetData: tweet,
				});
			} else {
				result.consecutiveKnownTweets++;
				result.updatedTweets.push({
					id: tweet.id,
					tweetData: tweet,
				});
			}

			// Only queue tweets with photos for image processing
			if (tweet.photos.length > 0) {
				result.tweetsToQueue.push({ tweet, userId });
			}

			// Stop if we've seen too many consecutive known tweets (unless force is enabled)
			if (!force && result.consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD) {
				logger.info(
					{
						userId,
						consecutiveKnownTweets: result.consecutiveKnownTweets,
						newTweetsInBatch: result.newTweetsInBatch,
						totalProcessed: index + 1,
					},
					"Stopping scrape after consecutive known tweets",
				);
				break;
			}
		}
	}

	return result;
}

export const scrapperWorker = new Worker<ScrapperJobData>(
	FEED_SCRAPPER_QUEUE,
	async (job) => {
		const { data } = job;
		const { userId } = data;

		logger.info({ userId, cursor: data.cursor, jobData: data }, "Scraping timeline");

		let user: User;

		try {
			user = await prisma.user.findUniqueOrThrow({
				where: {
					id: userId,
				},
			});
		} catch (error) {
			logger.error({ err: error, userId }, "User not found");
			throw error;
		}

		const userCookies = user.cookies;

		if (!userCookies) {
			logger.error({ userId }, "User cookies not found");
			await scrapperQueue.removeJobScheduler(`scrapper-${userId}`);

			await bot.api.sendPhoto(user.telegramId.toString(), `${env.BASE_CDN_URL}/moom.jpg`, {
				caption:
					"Can't scrape your timeline, no cookies?. Please setup your them in settings again and send /scrapper command again.",
			});

			return;
		}

		// Decrypt cookies with migration support
		let cookiesJson: string;
		try {
			cookiesJson = cookieEncryption.safeDecrypt(userCookies, user.telegramId.toString());
		} catch (error) {
			logger.error({ err: error, userId }, "Failed to decrypt user cookies");
			throw new Error("Failed to decrypt user cookies", { cause: error });
		}

		const cookies = Cookies.fromJSON(cookiesJson);

		const twid = cookies.userId();

		if (!twid) {
			logger.error({ userId }, "User ID not found");
			throw new Error("User ID not found");
		}

		const scrapper = new Scraper({ experimental: { xClientTransactionId: false, xpff: false } });
		await scrapper.setCookies(cookies.toString().split(";"));

		let timeline: QueryTweetsResponse;

		try {
			timeline = await scrapper.fetchLikedTweets(twid, 200, data.cursor);
		} catch (error) {
			logger.error(
				{
					userId,
					err: error,
				},
				"Unable to fetch timeline",
			);

			throw error;
		}

		logger.info(
			{
				userId,
				cursor: data.cursor,
				tweets: timeline.tweets.length,
			},
			"Scraped timeline",
		);

		// Step 1: Batch check existing tweets
		const tweetIds = timeline.tweets.map((tweet) => tweet.id).filter((id) => id !== undefined);

		const existingTweets = await prisma.tweet.findMany({
			where: {
				userId,
				id: { in: tweetIds },
				photos: { every: { s3Path: { not: null } } },
			},
			select: { id: true, createdAt: true },
		});
		const existingTweetMap = new Map(existingTweets.map((tweet) => [tweet.id, tweet.createdAt]));

		// Step 2: Process tweets and build batch operations
		const { newTweets, updatedTweets, tweetsToQueue, consecutiveKnownTweets, newTweetsInBatch } =
			collectTimelineTweets(timeline.tweets, existingTweetMap, userId, data.force);

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
			await imagesQueue.addBulk(
				tweetsToQueue.map((imageJob) => ({
					name: `post-${imageJob.tweet.id}`,
					data: imageJob,
					opts: {
						jobId: `post-${imageJob.tweet.id}-${imageJob.userId}`,
						deduplication: { id: `post-${imageJob.tweet.id}-${imageJob.userId}` },
					},
				})),
			);
		}

		data.count += timeline.tweets.length;

		// Stop if we hit consecutive threshold or other limits
		if (
			(!data.force && consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD) ||
			data.count >= data.limit ||
			!timeline.next
		) {
			let reason: string;
			if (!data.force && consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD) {
				reason = "consecutive_threshold";
			} else if (data.count >= data.limit) {
				reason = "count_limit";
			} else {
				reason = "no_next_cursor";
			}

			logger.info(
				{
					userId,
					count: data.count,
					limit: data.limit,
					consecutiveKnownTweets,
					newTweetsInBatch,
					force: data.force,
					reason,
				},
				"Stopping scrape job",
			);
			return;
		}

		await scrapperQueue.add(
			FEED_SCRAPPER_QUEUE,
			{
				userId,
				count: data.count,
				limit: data.limit,
				cursor: timeline.next,
				force: data.force,
			},
			{
				delay: 60_000,
				deduplication: { id: `scrapper-${userId}-${timeline.next}` },
			},
		);

		logger.info({ userId, count: data.count, limit: data.limit }, "Scraping next page");
	},
	{
		connection: redis,
		concurrency: 1,
		autorun: false,
	},
);

scrapperWorker.on("failed", (job) => {
	logger.error(
		{ err: job?.failedReason, jobId: job?.id, stack: job?.stacktrace, userId: job?.data.userId },
		"Scrapper job failed",
	);
});

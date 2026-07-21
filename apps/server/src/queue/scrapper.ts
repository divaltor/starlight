import { Absurd } from "absurd-sdk";
import { CookieEncryption } from "@starlight/crypto";
import type { User } from "@starlight/utils";
import { env, prisma } from "@starlight/utils";
import { type QueryTweetsResponse, Scraper, type Tweet } from "@the-convocation/twitter-scraper";
import { bot } from "@/bot";
import { logger } from "@/logger";
import { QUEUES, RETRY } from "@/queue/absurd";
import { imagesApp } from "@/queue/image-collector";
import { Cookies } from "@/storage";

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);

export const SCHEDULED_SCRAPPER_INTERVAL_SECONDS = 60 * 60 * 6;

export function getScheduledScrapperGeneration(date = new Date()) {
	return Math.floor(date.getTime() / (SCHEDULED_SCRAPPER_INTERVAL_SECONDS * 1000));
}

export const scrapperApp = new Absurd({
	db: env.DATABASE_URL,
	log: {
		log: logger.debug.bind(logger),
		info: logger.info.bind(logger),
		warn: logger.warn.bind(logger),
		error: logger.error.bind(logger),
	},
	queueName: QUEUES.scrapper,
});

export interface ScrapperJobData {
	count: number;
	cursor?: string;
	force?: boolean;
	limit: number;
	userId: string;
}

export interface ScheduledScrapperJobData {
	generation: number;
	limit: number;
	userId: string;
}

interface DelayedScrapperJobData {
	delaySeconds: number;
	idempotencyKey?: string;
	job: ScrapperJobData;
}

scrapperApp.registerTask<DelayedScrapperJobData>(
	{ name: "delayed-feed-scrapper" },
	async (data, ctx) => {
		await ctx.sleepFor("delay", data.delaySeconds);
		await scrapperApp.spawn("feed-scrapper", data.job, {
			idempotencyKey: data.idempotencyKey,
			maxAttempts: 3,
			retryStrategy: RETRY.scrapper,
		});
	},
);

scrapperApp.registerTask<ScheduledScrapperJobData>(
	{ name: "scheduled-feed-scrapper" },
	async (data, ctx) => {
		await ctx.sleepFor("next-run", SCHEDULED_SCRAPPER_INTERVAL_SECONDS);

		try {
			const user = await prisma.user.findUnique({
				where: { id: data.userId },
				select: { cookies: true },
			});

			if (!user?.cookies) {
				logger.info({ userId: data.userId }, "Skipping scheduled scrapper: user has no cookies");
			} else {
				await ctx.step("spawn-run", () =>
					scrapperApp.spawn(
						"feed-scrapper",
						{ count: 0, limit: data.limit, userId: data.userId },
						{
							idempotencyKey: `scheduled-feed-scrapper-${data.userId}-${data.generation}`,
							maxAttempts: 3,
							retryStrategy: RETRY.scrapper,
						},
					),
				);
			}
		} finally {
			const nextGeneration = data.generation + 1;
			await ctx.step("schedule-next-run", () =>
				scrapperApp.spawn(
					"scheduled-feed-scrapper",
					{
						generation: nextGeneration,
						limit: data.limit,
						userId: data.userId,
					},
					{
						idempotencyKey: `scheduled-scrapper-${data.userId}-${nextGeneration}`,
						maxAttempts: 3,
						retryStrategy: RETRY.scrapper,
					},
				),
			);
		}
	},
);

scrapperApp.registerTask<ScrapperJobData>({ name: "feed-scrapper" }, async (data) => {
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
		logger.error({ userId, error }, "User not found");
		throw error;
	}

	const userCookies = user.cookies;

	if (!userCookies) {
		logger.error({ userId }, "User cookies not found");

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
		logger.error({ userId, error }, "Failed to decrypt user cookies");
		throw new Error("Failed to decrypt user cookies");
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
				error: String(error),
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

	const CONSECUTIVE_THRESHOLD = 15;

	// Step 1: Batch check existing tweets
	const tweetIds = timeline.tweets.map((tweet) => tweet.id).filter((id) => id !== undefined);

	const existingTweetMap = new Map(
		(
			await prisma.tweet.findMany({
				where: {
					userId,
					id: { in: tweetIds },
					photos: { every: { s3Path: { not: null } } },
				},
				select: { id: true, createdAt: true },
			})
		).map((tweet) => [tweet.id, tweet.createdAt]),
	);

	// Step 2: Process tweets and build batch operations
	const newTweets: Array<{
		id: string;
		userId: string;
		tweetData: Tweet;
	}> = [];
	const updatedTweets: Array<{ id: string; tweetData: Tweet }> = [];
	const tweetsToQueue: Array<{ tweet: Tweet; userId: string }> = [];

	let consecutiveKnownTweets = 0;
	let newTweetsInBatch = 0;

	for (const tweet of timeline.tweets) {
		if (!tweet.id) {
			continue;
		}

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
		if (tweet.photos.length > 0) {
			tweetsToQueue.push({ tweet, userId });
		}

		// Stop if we've seen too many consecutive known tweets (unless force is enabled)
		if (!data.force && consecutiveKnownTweets >= CONSECUTIVE_THRESHOLD) {
			logger.info(
				{
					userId,
					consecutiveKnownTweets,
					newTweetsInBatch,
					totalProcessed: timeline.tweets.indexOf(tweet) + 1,
				},
				"Stopping scrape after consecutive known tweets",
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
		await Promise.all(
			tweetsToQueue.map((job) =>
				imagesApp.spawn("images-collector", job, {
					idempotencyKey: `post-${job.tweet.id}-${job.userId}`,
					maxAttempts: 3,
					retryStrategy: RETRY.images,
				}),
			),
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

	await scrapperApp.spawn(
		"delayed-feed-scrapper",
		{
			delaySeconds: 60,
			idempotencyKey: `scrapper-${userId}-${timeline.next}`,
			job: {
				userId,
				count: data.count,
				limit: data.limit,
				cursor: timeline.next,
				force: data.force,
			},
		},
		{
			idempotencyKey: `delay-scrapper-${userId}-${timeline.next}`,
			maxAttempts: 3,
			retryStrategy: RETRY.scrapper,
		},
	);

	logger.info({ userId, count: data.count, limit: data.limit }, "Scraping next page");
});

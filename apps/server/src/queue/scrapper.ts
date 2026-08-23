import { getTwitterCookies } from "@starlight/api/services/twitter-credential";
import type { User } from "@starlight/utils";
import { env, prisma } from "@starlight/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Scraper } from "@the-convocation/twitter-scraper";
import { Queue, Worker } from "bullmq";
import { bot } from "@/bot";
import { logger } from "@/logger";
import { mediaCollectorQueue, type MediaCollectorJobData } from "@/queue/media-collector";
import { mediaResolvedWhere } from "@/services/media-resolution";
import { normalizeTwitterTags } from "@/services/twitter-tags";
import { Cookies, redis } from "@/storage";

export const SCHEDULED_SCRAPPER_INTERVAL_SECONDS = 60 * 60 * 6;
const CONSECUTIVE_THRESHOLD = 15;

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

function collectTimelineTweets(
	tweets: Tweet[],
	existingPostIds: Set<string>,
	userId: string,
	force = false,
) {
	const jobs: MediaCollectorJobData[] = [];
	let consecutiveKnown = 0;

	for (const tweet of tweets) {
		if (!tweet.id) {
			continue;
		}
		consecutiveKnown = existingPostIds.has(tweet.id) ? consecutiveKnown + 1 : 0;
		if (tweet.photos.length > 0) {
			jobs.push({
				userId,
				post: {
					provider: "twitter",
					externalId: tweet.id,
					sourceUrl: `https://x.com/i/status/${tweet.id}`,
					authorExternalId: tweet.userId,
					authorName: tweet.name,
					authorUsername: tweet.username,
					text: tweet.text,
					tags: normalizeTwitterTags(tweet),
					providerPayload: tweet,
					media: tweet.photos.map((photo, position) => ({ externalId: photo.id, url: photo.url, position, kind: "image" })),
				},
			});
		}
		if (!force && consecutiveKnown >= CONSECUTIVE_THRESHOLD) {
			break;
		}
	}

	return { consecutiveKnown, jobs };
}

export const scrapperWorker = new Worker<ScrapperJobData>(
	FEED_SCRAPPER_QUEUE,
	async (job) => {
		const { data } = job;
		const user = await getUser(data.userId);
		const userCookies = await getTwitterCookies(user.id);
		if (!userCookies) {
			logger.error({ userId: data.userId }, "User cookies not found");
			await scrapperQueue.removeJobScheduler(`scrapper-${data.userId}`);
			await bot.api.sendPhoto(user.telegramId.toString(), `${env.BASE_CDN_URL}/moom.jpg`, { caption: "Can't scrape your timeline, no cookies. Please set them in Settings and send /scrapper again." });
			return;
		}

		const cookies = Cookies.fromJSON(userCookies);
		const twid = cookies.userId();
		if (!twid) {
			throw new Error("User ID not found");
		}
		const scrapper = new Scraper({ experimental: { xClientTransactionId: false, xpff: false } });
		await scrapper.setCookies(cookies.toString().split(";"));
		const timeline = await scrapper.fetchLikedTweets(twid, 200, data.cursor);
		const postIds = timeline.tweets.flatMap((tweet) => (tweet.id ? [tweet.id] : []));
		const existingPostIds = new Set((await prisma.post.findMany({ where: { userId: data.userId, provider: "twitter", id: { in: postIds }, media: { every: mediaResolvedWhere } }, select: { id: true } })).map((post) => post.id));
		const { consecutiveKnown, jobs } = collectTimelineTweets(timeline.tweets, existingPostIds, data.userId, data.force);
		if (jobs.length > 0) {
			await mediaCollectorQueue.addBulk(jobs.map((mediaJob) => ({ name: `post-${mediaJob.post.provider}-${mediaJob.post.externalId}`, data: mediaJob, opts: { jobId: `post-${mediaJob.post.provider}-${mediaJob.post.externalId}-${mediaJob.userId}`, deduplication: { id: `post-${mediaJob.post.provider}-${mediaJob.post.externalId}-${mediaJob.userId}` } } })));
		}

		const count = data.count + timeline.tweets.length;
		if ((!data.force && consecutiveKnown >= CONSECUTIVE_THRESHOLD) || count >= data.limit || !timeline.next) {
			logger.info({ userId: data.userId, count, limit: data.limit, consecutiveKnown }, "Stopping scrape job");
			return;
		}
		await scrapperQueue.add(FEED_SCRAPPER_QUEUE, { ...data, count, cursor: timeline.next }, { delay: 60_000, deduplication: { id: `scrapper-${data.userId}-${timeline.next}` } });
	},
	{ connection: redis, concurrency: 1, autorun: false },
);

scrapperWorker.on("failed", (job) => {
	logger.error({ err: job?.failedReason, jobId: job?.id, stack: job?.stacktrace, userId: job?.data.userId }, "Scrapper job failed");
});

async function getUser(userId: string): Promise<User> {
	try {
		return await prisma.user.findUniqueOrThrow({ where: { id: userId } });
	} catch (error) {
		logger.error({ err: error, userId }, "User not found");
		throw error;
	}
}

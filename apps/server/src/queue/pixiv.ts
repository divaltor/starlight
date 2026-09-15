import { withPixivClient } from "@starlight/api/services/pixiv-credential";
import { prisma } from "@starlight/utils";
import { Queue, Worker } from "bullmq";
import { logger } from "@/logger";
import { mediaCollectorQueue } from "@/queue/media-collector";
import type { MediaCollectorJobData } from "@/queue/media-collector";
import { mediaResolvedWhere } from "@/services/media-resolution";
import { redis } from "@/storage";

const CONSECUTIVE_THRESHOLD = 15;
const PIXIV_QUEUE = "pixiv-bookmarks";
export const SCHEDULED_PIXIV_INTERVAL_SECONDS = 60 * 60 * 6;

export interface PixivCrawlJobData {
	userId: string;
	runId: string;
	count: number;
	limit: number;
	cursor?: number;
	visibility?: "public" | "private";
}

export const pixivQueue = new Queue<PixivCrawlJobData>(PIXIV_QUEUE, {
	connection: redis,
	defaultJobOptions: {
		attempts: 3,
		backoff: { type: "exponential", delay: 150_000 },
		removeOnComplete: { age: 60 * 60 * 24, count: 2000 },
		removeOnFail: { age: 60 * 60 * 24, count: 2000 },
	},
});

export const pixivWorker = new Worker<PixivCrawlJobData>(
	PIXIV_QUEUE,
	async (job) => {
		const { data } = job;
		if (!data.visibility) {
			const runId = data.runId === "scheduled" ? `scheduled-${job.id}` : data.runId;
			const user = await prisma.user.findUnique({ where: { id: data.userId }, select: { pixivIncludePrivate: true, providerCredentials: { where: { provider: "pixiv", credentialType: "refresh_token" } } } });
			if (!user?.providerCredentials.length) {
				return;
			}
			const visibilities: ("public" | "private")[] = user.pixivIncludePrivate ? ["public", "private"] : ["public"];
			await pixivQueue.addBulk(visibilities.map((visibility) => ({ name: PIXIV_QUEUE, data: { ...data, count: 0, runId, visibility }, opts: { jobId: `pixiv-${data.userId}-${runId}-${visibility}-start`, deduplication: { id: `pixiv-${data.userId}-${runId}-${visibility}-start` } } })));
			return;
		}

		const page = await withPixivClient(data.userId, (client) => client.bookmarks({ cursor: data.cursor, visibility: data.visibility! }));
		if (!page) {
			return;
		}
		const knownPosts = await prisma.post.findMany({ where: { userId: data.userId, provider: "pixiv", id: { in: page.artworks.map((artwork) => artwork.id) }, media: { every: mediaResolvedWhere } }, select: { id: true } });
		const known = new Set(knownPosts.map((post) => post.id));
		let consecutiveKnown = 0;
		const jobs: MediaCollectorJobData[] = [];
		for (const artwork of page.artworks) {
			consecutiveKnown = known.has(artwork.id) ? consecutiveKnown + 1 : 0;
			jobs.push({ userId: data.userId, post: { provider: "pixiv", externalId: artwork.id, sourceUrl: artwork.sourceUrl, authorExternalId: artwork.author.id, authorName: artwork.author.name, authorUsername: artwork.author.username, title: artwork.title, text: artwork.caption, tags: artwork.tags, providerPayload: { starlightMediaType: artwork.type }, media: artwork.mediaUrls.map((url, position) => ({ externalId: `${artwork.id}:${position}`, url, position, kind: artwork.type === "ugoira" ? "animation-preview" : "image", fetchHeaders: { Referer: "https://www.pixiv.net/" } })) } });
			if (consecutiveKnown >= CONSECUTIVE_THRESHOLD) {
				break;
			}
		}
		await mediaCollectorQueue.addBulk(jobs.map((mediaJob) => ({ name: `post-pixiv-${mediaJob.post.externalId}`, data: mediaJob, opts: { jobId: `post-pixiv-${mediaJob.post.externalId}-${mediaJob.userId}`, deduplication: { id: `post-pixiv-${mediaJob.post.externalId}-${mediaJob.userId}` } } })));
		const count = data.count + page.artworks.length;
		if (consecutiveKnown >= CONSECUTIVE_THRESHOLD || count >= data.limit || !page.nextCursor) {
			return;
		}
		await pixivQueue.add(PIXIV_QUEUE, { ...data, count, cursor: page.nextCursor }, { deduplication: { id: `pixiv-${data.userId}-${data.runId}-${data.visibility}-${page.nextCursor}` } });
	},
	{ connection: redis, concurrency: 1, autorun: false },
);

pixivWorker.on("failed", (job) => {
	logger.error({ err: job?.failedReason, jobId: job?.id, stack: job?.stacktrace, userId: job?.data.userId }, "Pixiv worker failed");
});

import { Absurd } from "absurd-sdk";
import { withPixivClient } from "@starlight/api/services/pixiv-credential";
import { env, prisma } from "@starlight/utils";
import { absurdLogger, QUEUES, RETRY } from "@/queue/absurd";
import { imagesApp, type MediaCollectorJobData } from "@/queue/image-collector";

const CONSECUTIVE_THRESHOLD = 15;
const SCHEDULE_INTERVAL_SECONDS = 60 * 60 * 6;

export const pixivApp = new Absurd({
	db: env.DATABASE_URL,
	log: absurdLogger,
	queueName: QUEUES.pixiv,
});

export interface PixivCrawlJobData {
	userId: string;
	runId: string;
	count: number;
	limit: number;
	cursor?: number;
	visibility?: "public" | "private";
	force?: boolean;
}

export interface ScheduledPixivJobData {
	generation: number;
	limit: number;
	userId: string;
}

export const getScheduledPixivGeneration = (date = new Date()) =>
	Math.floor(date.getTime() / (SCHEDULE_INTERVAL_SECONDS * 1000));

pixivApp.registerTask<ScheduledPixivJobData>(
	{ name: "scheduled-pixiv-bookmarks" },
	async (data, ctx) => {
		await ctx.sleepFor("next-run", SCHEDULE_INTERVAL_SECONDS);
		try {
			const credential = await prisma.providerCredential.findUnique({
				where: { userId_provider: { userId: data.userId, provider: "pixiv" } },
				select: { credentialType: true },
			});
			if (credential?.credentialType === "refresh_token") {
				await pixivApp.spawn(
					"pixiv-bookmarks",
					{
						count: 0,
						limit: data.limit,
						runId: `scheduled-${data.generation}`,
						userId: data.userId,
					},
					{
						idempotencyKey: `scheduled-pixiv-run-${data.userId}-${data.generation}`,
						maxAttempts: 3,
						retryStrategy: RETRY.pixiv,
					},
				);
			}
		} finally {
			const nextGeneration = data.generation + 1;
			await pixivApp.spawn(
				"scheduled-pixiv-bookmarks",
				{ ...data, generation: nextGeneration },
				{
					idempotencyKey: `scheduled-pixiv-${data.userId}-${nextGeneration}`,
					maxAttempts: 3,
					retryStrategy: RETRY.pixiv,
				},
			);
		}
	},
);

pixivApp.registerTask<PixivCrawlJobData>({ name: "pixiv-bookmarks" }, async (data) => {
	if (!data.visibility) {
		const user = await prisma.user.findUnique({
			where: { id: data.userId },
			select: {
				pixivIncludePrivate: true,
				providerCredentials: {
					where: { provider: "pixiv", credentialType: "refresh_token" },
				},
			},
		});
		if (!user?.providerCredentials.length) {
			return;
		}
		const visibilities: Array<"public" | "private"> = ["public"];
		if (user.pixivIncludePrivate) {
			visibilities.push("private");
		}
		await Promise.all(
			visibilities.map((visibility) =>
				pixivApp.spawn(
					"pixiv-bookmarks",
					{ ...data, count: 0, cursor: undefined, visibility },
					{
						idempotencyKey: `pixiv-${data.userId}-${data.runId}-${visibility}-start-${data.force ? "force" : "normal"}`,
						maxAttempts: 3,
						retryStrategy: RETRY.pixiv,
					},
				),
			),
		);
		return;
	}

	const page = await withPixivClient(data.userId, (client) =>
		client.bookmarks({ cursor: data.cursor, visibility: data.visibility! }),
	);
	if (!page) {
		return;
	}
	const known = new Set(
		(
			await prisma.post.findMany({
				where: {
					userId: data.userId,
					provider: "pixiv",
					id: { in: page.artworks.map((artwork) => artwork.id) },
					photos: { every: { s3Path: { not: null } } },
				},
				select: { id: true },
			})
		).map((post) => post.id),
	);

	let consecutiveKnown = 0;
	for (const artwork of page.artworks) {
		consecutiveKnown = known.has(artwork.id) ? consecutiveKnown + 1 : 0;
		const job: MediaCollectorJobData = {
			userId: data.userId,
			post: {
				provider: "pixiv",
				externalId: artwork.id,
				sourceUrl: artwork.sourceUrl,
				authorExternalId: artwork.author.id,
				authorName: artwork.author.name,
				authorUsername: artwork.author.username,
				title: artwork.title,
				text: artwork.caption,
				tags: artwork.tags,
				providerPayload: { starlightMediaType: artwork.type },
				media: artwork.mediaUrls.map((url, position) => ({
					externalId: `${artwork.id}:${position}`,
					url,
					position,
					kind: artwork.type === "ugoira" ? "animation-preview" : "image",
					fetchHeaders: { Referer: "https://www.pixiv.net/" },
				})),
			},
		};
		await imagesApp.spawn("images-collector", job, {
			idempotencyKey: `media-pixiv-${data.userId}-${artwork.id}`,
			maxAttempts: 3,
			retryStrategy: RETRY.images,
		});
		if (!data.force && consecutiveKnown >= CONSECUTIVE_THRESHOLD) {
			break;
		}
	}

	const count = data.count + page.artworks.length;
	if (
		(!data.force && consecutiveKnown >= CONSECUTIVE_THRESHOLD) ||
		count >= data.limit ||
		!page.nextCursor
	) {
		return;
	}
	await pixivApp.spawn(
		"pixiv-bookmarks",
		{ ...data, count, cursor: page.nextCursor },
		{
			idempotencyKey: `pixiv-${data.userId}-${data.runId}-${data.visibility}-${page.nextCursor}`,
			maxAttempts: 3,
			retryStrategy: RETRY.pixiv,
		},
	);
});

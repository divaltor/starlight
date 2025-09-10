import { CollectionShareVisibility, getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateSlug } from "@/lib/utils";
import { authMiddleware } from "@/middleware/auth";

const createCollectionSchema = z.object({
	name: z.string().max(80).optional(),
	tweetIds: z.array(z.string()).optional(),
	authors: z.array(z.string()).optional(),
	visibility: z
		.enum([CollectionShareVisibility.PUBLIC, CollectionShareVisibility.PRIVATE])
		.optional(),
});

const updateCollectionSchema = z.object({
	id: z.string(),
	name: z.string().max(80).optional(),
	tweetIds: z.array(z.string()).optional(),
	authors: z.array(z.string()).optional(),
});

export const createCollectionShare = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(createCollectionSchema)
	.handler(async ({ context, data }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		const slug = generateSlug();

		const collectionShare = await prisma.collectionShare.create({
			data: {
				userId,
				slug,
				name: data.name || "",
				visibility: data.visibility || CollectionShareVisibility.PUBLIC,
				collectionShareTweets: {
					create:
						data.tweetIds?.map((tweetId: string) => ({
							tweetId,
							tweetUserId: userId,
						})) || [],
				},
				collectionShareAuthors: {
					create:
						data.authors?.map((username: string) => ({
							username: username.toLowerCase(),
						})) || [],
				},
			},
			select: {
				id: true,
				slug: true,
				name: true,
				createdAt: true,
				collectionShareTweets: { select: { id: true } },
				collectionShareAuthors: { select: { id: true } },
			},
		});

		return {
			id: collectionShare.id,
			slug: collectionShare.slug,
			name: collectionShare.name,
			createdAt: collectionShare.createdAt,
			visibility: data.visibility || CollectionShareVisibility.PUBLIC,
			tweetCount: collectionShare.collectionShareTweets.length,
			authorCount: collectionShare.collectionShareAuthors.length,
		};
	});

export const getCollectionShares = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		const collections = await prisma.collectionShare.findMany({
			where: {
				userId,
			},
			select: {
				id: true,
				slug: true,
				name: true,
				createdAt: true,
				_count: {
					select: { collectionShareTweets: true, collectionShareAuthors: true },
				},
				collectionShareTweets: {
					include: {
						tweet: {
							include: {
								photos: true,
							},
						},
					},
					take: 5,
					where: {
						tweet: prisma.tweet.available(),
					},
				},
			},
			orderBy: { createdAt: "desc" },
		});

		return collections.map((c) => ({
			id: c.id,
			slug: c.slug,
			name: c.name,
			createdAt: c.createdAt,
			visibility: CollectionShareVisibility.PUBLIC,
			tweetCount: c._count.collectionShareTweets,
			authorCount: c._count.collectionShareAuthors,
			tweets: c.collectionShareTweets.map((t) => ({
				id: t.tweet.id,
				photo: t.tweet.photos[0].s3Url,
			})),
		}));
	});

export type CollectionShare = Awaited<
	ReturnType<typeof getCollectionShares>
>[number];

export const updateCollectionShare = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(updateCollectionSchema)
	.handler(async ({ context, data }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;
		const collectionId = data.id;

		// Verify ownership
		const collection = await prisma.collectionShare.findFirst({
			where: {
				id: collectionId,
				userId,
				visibility: CollectionShareVisibility.PUBLIC,
			},
		});

		if (!collection) {
			throw new Error("Collection not found");
		}

		await prisma.collectionShare.update({
			where: { id: collectionId },
			data: {
				name: data.name,
				collectionShareTweets: {
					create: data.tweetIds?.map((tweetId: string) => ({
						tweetId,
						tweetUserId: userId,
					})),
					deleteMany: data.tweetIds
						? { tweetId: { in: data.tweetIds } }
						: undefined,
				},
				collectionShareAuthors: {
					create: data.authors?.map((username: string) => ({
						username: username.toLowerCase(),
					})),
					deleteMany: data.authors
						? {
								username: {
									in: data.authors?.map((u: string) => u.toLowerCase()),
								},
							}
						: undefined,
				},
			},
		});

		return { success: true };
	});

export const revokeProfileShare = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ context, data }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;
		const profileId = data.id;

		await prisma.profileShare.update({
			where: { id: profileId, userId },
			data: { revokedAt: new Date() },
		});

		return { success: true };
	});

export const changeCollectionShareVisibility = createServerFn({
	method: "POST",
})
	.middleware([authMiddleware])
	.validator(
		z.object({
			id: z.string(),
			visibility: z.enum([
				CollectionShareVisibility.PUBLIC,
				CollectionShareVisibility.PRIVATE,
			]),
		}),
	)
	.handler(async ({ context, data }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;
		const collectionId = data.id;

		await prisma.collectionShare.update({
			where: { id: collectionId, userId },
			data: { visibility: data.visibility },
		});
	});

// Add a tweet to a collection (or auto-create default collection if none specified)
const addTweetToCollectionSchema = z.object({
	collectionId: z.string().optional(),
	tweetId: z.string(),
	// If collectionId not provided and user has zero collections, optional name/visibility
	name: z.string().max(80).optional(),
	visibility: z
		.enum([CollectionShareVisibility.PUBLIC, CollectionShareVisibility.PRIVATE])
		.optional(),
});

export const addTweetToCollectionShare = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(addTweetToCollectionSchema)
	.handler(async ({ context, data }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;
		const { collectionId, tweetId } = data;

		// Verify tweet belongs to user
		const tweet = await prisma.tweet.findFirst({
			where: { id: tweetId, userId },
			select: { id: true, userId: true },
		});
		if (!tweet) throw new Error("Tweet not found");

		let targetCollectionId = collectionId;

		if (!targetCollectionId) {
			// Check existing collections
			const existing = await prisma.collectionShare.findMany({
				where: { userId },
				select: { id: true },
				orderBy: { createdAt: "asc" },
			});

			if (existing.length === 0) {
				// Auto-create
				const created = await prisma.collectionShare.create({
					data: {
						userId,
						slug: generateSlug(),
						name: data.name || "Favorites",
						visibility: data.visibility || CollectionShareVisibility.PUBLIC,
					},
					select: { id: true, name: true },
				});
				targetCollectionId = created.id;
			} else if (existing.length === 1) {
				targetCollectionId = existing[0].id;
			} else {
				throw new Error("Multiple collections exist; specify collectionId");
			}
		} else {
			// Validate ownership of provided collection
			const collection = await prisma.collectionShare.findFirst({
				where: { id: targetCollectionId, userId },
				select: { id: true },
			});
			if (!collection) throw new Error("Collection not found");
		}

		// Upsert relation (ignore duplicates)
		try {
			await prisma.collectionShareTweet.create({
				data: {
					collectionShareId: targetCollectionId!,
					tweetId,
					tweetUserId: userId,
				},
			});
		} catch (e: any) {
			// Unique constraint violation => treat as success
		}

		return { success: true, collectionId: targetCollectionId };
	});

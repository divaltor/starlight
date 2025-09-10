import { getPrismaClient, type Prisma } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type CursorData, CursorPagination } from "@/lib/pagination";
import { authMiddleware } from "@/middleware/auth";
import type { TweetData } from "@/types/tweets";

const schema = z.object({
	id: z.string(),
	cursor: z.string().optional(),
	limit: z.number().min(1).max(100).default(30),
});

export const getCollectionTweets = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator(schema)
	.handler(
		async ({
			data,
			context,
		}): Promise<{ tweets: TweetData[]; nextCursor: string | null }> => {
			const prisma = getPrismaClient();
			const { id, cursor, limit } = data;
			const userId = context.databaseUserId;

			// Verify collection ownership & visibility (only user's public collections)
			const collection = await prisma.collectionShare.findFirst({
				where: { id, userId },
				select: { id: true },
			});

			if (!collection) throw new Error("Collection not found");

			let cursorData: CursorData | null = null;
			if (cursor) {
				cursorData = CursorPagination.parseCursor(cursor);
				if (!cursorData) return { tweets: [], nextCursor: null };
			}

			const whereClause: Prisma.TweetWhereInput = {
				userId,
				collectionShareTweets: {
					some: { collectionShareId: id },
				},
			};

			if (cursorData) {
				const cursorDate = new Date(cursorData.createdAt);
				whereClause.OR = [
					{ createdAt: { lt: cursorDate } },
					{ createdAt: cursorDate, id: { lt: cursorData.lastTweetId } },
				];
			}

			const tweets = await prisma.tweet.findMany({
				where: { ...whereClause, ...prisma.tweet.available() },
				include: {
					photos: {
						where: prisma.photo.available(),
						orderBy: { createdAt: "desc" },
					},
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: limit,
			});

			let nextCursor: string | null = null;
			if (tweets.length === limit && tweets.length > 0) {
				const lastTweet = tweets[tweets.length - 1];
				nextCursor = CursorPagination.createCursor({
					lastTweetId: lastTweet.id,
					createdAt: lastTweet.createdAt.toISOString(),
				});
			}

			const transformedTweets: TweetData[] = tweets.map((tweet) => ({
				id: tweet.id,
				artist: tweet.username ? `@${tweet.username}` : "@good_artist",
				date: tweet.createdAt.toISOString(),
				photos: tweet.photos.map((p) => ({ id: p.id, url: p.s3Url! })),
				hasMultipleImages: tweet.photos.length > 1,
				sourceUrl: `https://x.com/i/status/${tweet.id}`,
			}));

			return { tweets: transformedTweets, nextCursor };
		},
	);

import { getPrismaClient, type Prisma } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type CursorData, CursorPagination } from "@/lib/pagination";
import type { TweetData } from "@/types/tweets";

const profileSchema = z.object({
	slug: z.string(),
	cursor: z.string().optional(),
	limit: z.number().min(1).max(100).default(30),
});

export const getProfileShare = createServerFn({ method: "GET" })
	.validator(profileSchema)
	.handler(
		async ({
			data,
		}): Promise<{ tweets: TweetData[]; nextCursor: string | null }> => {
			const prisma = getPrismaClient();
			const slug = data.slug;

			// Find profile share
			const profileShare = await prisma.profileShare.findUnique({
				where: { slug, revokedAt: null },
				include: {
					user: {
						select: {
							firstName: true,
							lastName: true,
							username: true,
						},
					},
				},
			});

			if (!profileShare) {
				throw new Error("Profile share not found");
			}

			const { cursor, limit } = data;
			const userId = profileShare.userId;

			// Parse cursor using shared pagination utility
			let cursorData: CursorData | null = null;
			if (cursor) {
				cursorData = CursorPagination.parseCursor(cursor);

				if (!cursorData) {
					return { tweets: [], nextCursor: null };
				}
			}

			// Build where clause with cursor pagination logic
			const whereClause: Prisma.TweetWhereInput = {
				userId,
			};

			if (cursorData) {
				const cursorDate = new Date(cursorData.createdAt);
				whereClause.OR = [
					{ createdAt: { lt: cursorDate } },
					{ createdAt: cursorDate, id: { lt: cursorData.lastTweetId } },
				];
			}

			// Fetch tweets (newest first) ensuring only tweets with available photos
			const tweets = await prisma.tweet.findMany({
				where: { ...whereClause, ...prisma.tweet.available() },
				include: {
					photos: {
						where: prisma.photo.available(),
						orderBy: { createdAt: "desc" },
						select: {
							id: true,
							s3Url: true,
						},
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

			// Transform to unified response format
			const transformedTweets: TweetData[] = tweets.map((tweet) => {
				const photos = tweet.photos.map((photo) => ({
					id: photo.id,
					// biome-ignore lint/style/noNonNullAssertion: ensured by available() filter
					url: photo.s3Url!,
				}));

				return {
					id: tweet.id,
					artist: tweet.username ? `@${tweet.username}` : "@good_artist",
					date: tweet.createdAt.toISOString(),
					photos,
					hasMultipleImages: photos.length > 1,
					sourceUrl: `https://x.com/i/status/${tweet.id}`,
				};
			});

			return {
				tweets: transformedTweets,
				nextCursor,
			};
		},
	);

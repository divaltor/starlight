import { getPrismaClient, type Prisma } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { z } from "zod/v4";
import { type CursorData, CursorPagination } from "@/lib/pagination";
import { authMiddleware } from "@/middleware/auth";

interface PhotoData {
	id: string;
	url: string;
}

interface TweetData {
	id: string;
	artist: string;
	date: string;
	photos: PhotoData[];
	hasMultipleImages: boolean;
	sourceUrl?: string;
}

const getUserTweets = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator(
		z.object({
			cursor: z.string().optional(),
			limit: z.number().min(1).max(100).default(30),
			dateFilter: z
				.enum(["all", "today", "yesterday", "3 days", "week"])
				.optional(),
		}),
	)
	.handler(
		async ({
			data,
			context,
		}): Promise<{
			tweets: TweetData[];
			nextCursor: string | null;
		}> => {
			const { cursor, limit, dateFilter } = data;

			try {
				// Parse cursor if provided
				let cursorData: CursorData | null = null;
				if (cursor) {
					cursorData = CursorPagination.parseCursor(cursor);

					// Invalid cursor
					if (!cursorData) {
						return {
							tweets: [],
							nextCursor: null,
						};
					}
				}

				// Build where clause for cursor pagination and filters
				const whereClause: Prisma.TweetWhereInput = {
					// Filter by requesting user only
					userId: context.databaseUserId,
				};

				const createdAt: Prisma.TweetWhereInput["createdAt"] = {};

				// Apply date filter
				if (dateFilter && dateFilter !== "all") {
					const now = new Date();
					const cutoffDate = new Date();

					switch (dateFilter) {
						case "today":
							cutoffDate.setHours(0, 0, 0, 0);
							break;
						case "week":
							cutoffDate.setDate(now.getDate() - 7);
							break;
						case "yesterday":
							cutoffDate.setDate(now.getDate() - 1);
							break;
						case "3 days":
							cutoffDate.setDate(now.getDate() - 3);
							break;
					}

					createdAt.gte = cutoffDate;
				}

				if (cursorData) {
					const cursorDate = new Date(cursorData.createdAt);
					whereClause.OR = [
						{ createdAt: { lt: cursorDate } },
						{ createdAt: cursorDate, id: { lt: cursorData.lastTweetId } },
					];
				}

				const prisma = getPrismaClient();

				// Fetch tweets with pagination - only tweets that have photos
				const tweets = await prisma.tweet.findMany({
					where: {
						...whereClause,
						...prisma.tweet.available(),
						createdAt,
					},
					include: {
						photos: {
							where: prisma.photo.available(),
							orderBy: {
								createdAt: "desc",
							},
						},
					},
					// Always order by newest first for consistent display
					orderBy: [
						{
							createdAt: "desc",
						},
						{
							id: "desc",
						},
					],
					take: limit,
				});

				const transformedTweets: TweetData[] = tweets.map((tweet) => {
					const photos = tweet.photos.map((photo) => ({
						id: photo.id,
						// biome-ignore lint/style/noNonNullAssertion: We filter out photos with null s3Path
						url: photo.s3Url!,
					}));

					const tweetData = tweet.tweetData as Tweet;
					const tweetUsername = tweetData?.username;

					return {
						id: tweet.id,
						artist: tweetUsername ? `@${tweetUsername}` : "@good_artist",
						date: tweet.createdAt.toISOString(),
						photos,
						hasMultipleImages: photos.length > 1,
						sourceUrl: `https://x.com/i/status/${tweet.id}`,
					};
				});

				let nextCursor = null;
				if (tweets.length === limit) {
					// biome-ignore lint/style/noNonNullAssertion: We know there's at least one tweet
					const lastTweet = tweets.at(-1)!;
					nextCursor = CursorPagination.createCursor({
						lastTweetId: lastTweet.id,
						createdAt: lastTweet.createdAt.toISOString(),
					});
				}

				return {
					tweets: transformedTweets,
					nextCursor,
				};
			} catch (error) {
				console.error("Failed to fetch user tweets:", error);
				return {
					tweets: [],
					nextCursor: null,
				};
			}
		},
	);

export { getUserTweets };

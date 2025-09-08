import { getPrismaClient, type Prisma } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { z } from "zod/v4";
import { type CursorData, CursorPagination } from "@/lib/pagination";
import { authMiddleware } from "@/middleware/auth";
import type { TweetData } from "@/types/tweets";

const getUserTweets = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator(
		z.object({
			cursor: z.string().optional(),
			limit: z.number().min(1).max(100).default(30),
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
			const { cursor, limit } = data;

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

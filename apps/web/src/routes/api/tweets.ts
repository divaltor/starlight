import { CursorPagination } from "@/lib/cursor-pagination";
import { getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod/v4";

// Type definitions based on your schema
interface PhotoData {
	id: string;
	url: string;
	alt: string;
}

interface TweetData {
	id: string;
	tweetUrl: string;
	artist: string;
	date: string;
	photos: PhotoData[];
	// Pre-computed values for performance optimization
	photoCount: number;
	firstPhotoId?: string;
	isMultiImage: boolean;
}

interface UserTweetsResponse {
	success: boolean;
	tweets: TweetData[];
	pagination: {
		hasNextPage: boolean;
		hasPreviousPage: boolean;
		nextCursor: string | null;
		previousCursor: string | null;
	};
	error?: string;
}

const getUserTweets = createServerFn({ method: "GET" })
	.validator(
		z.object({
			telegramId: z.number(),
			cursor: z.string().optional(),
			limit: z.number().min(1).max(100).default(30),
			dateFilter: z
				.enum(["all", "today", "week", "month", "3months", "6months", "year"])
				.optional(),
		}),
	)
	.handler(async ({ data }): Promise<UserTweetsResponse> => {
		const { telegramId, cursor, limit, dateFilter } = data;
		const userId = telegramId; // Use number directly

		try {
			// Parse cursor if provided
			let cursorData = null;
			if (cursor) {
				cursorData = CursorPagination.parseCursor(cursor, userId);
				if (!cursorData) {
					return {
						success: false,
						error: "Invalid or unauthorized cursor",
						tweets: [],
						pagination: {
							hasNextPage: false,
							hasPreviousPage: false,
							nextCursor: null,
							previousCursor: null,
						},
					};
				}
			}

			// First, find the user by telegram ID
			const user = await getPrismaClient().user.findUnique({
				where: {
					telegramId: BigInt(telegramId),
				},
			});

			if (!user) {
				return {
					success: false,
					error: "User not found",
					tweets: [],
					pagination: {
						hasNextPage: false,
						hasPreviousPage: false,
						nextCursor: null,
						previousCursor: null,
					},
				};
			}

			// Build where clause for cursor pagination and filters
			const whereClause: {
				userId: string;
				createdAt?: {
					lt?: Date;
					gt?: Date;
					gte?: Date;
				};
			} = {
				// Filter by requesting user only
				userId: user.id,
			};

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
					case "month":
						cutoffDate.setMonth(now.getMonth() - 1);
						break;
					case "3months":
						cutoffDate.setMonth(now.getMonth() - 3);
						break;
					case "6months":
						cutoffDate.setMonth(now.getMonth() - 6);
						break;
					case "year":
						cutoffDate.setFullYear(now.getFullYear() - 1);
						break;
				}

				if (whereClause.createdAt) {
					whereClause.createdAt.gte = cutoffDate;
				} else {
					whereClause.createdAt = { gte: cutoffDate };
				}
			}

			if (cursorData) {
				// For infinite scroll, we always want to go forward (older tweets)
				// So we use 'lt' (less than) to get tweets older than the cursor
				if (whereClause.createdAt) {
					whereClause.createdAt.lt = new Date(cursorData.lastCreatedAt);
				} else {
					whereClause.createdAt = {
						lt: new Date(cursorData.lastCreatedAt),
					};
				}
			}

			// Fetch tweets with pagination
			const tweets = await getPrismaClient().tweet.findMany({
				where: whereClause,
				include: {
					photos: {
						where: {
							deletedAt: null, // Only get non-deleted photos
							s3Path: {
								not: null,
							},
						},
						orderBy: {
							createdAt: "desc",
						},
					},
				},
				// Always order by newest first for consistent display
				orderBy: {
					createdAt: "desc",
				},
				take: limit + 1, // Fetch one extra to check if there are more
			});

			// Check if there are more tweets
			const hasMore = tweets.length > limit;
			const tweetsToReturn = hasMore ? tweets.slice(0, limit) : tweets;

			// Transform the data with performance optimizations
			const transformedTweets: TweetData[] = tweetsToReturn.map((tweet) => {
				const photos = tweet.photos.map((photo) => ({
					id: photo.id,
					// biome-ignore lint/style/noNonNullAssertion: We filter out photos with null s3Path
					url: photo.s3Url!,
					alt: `Photo from tweet ${tweet.id}`,
				}));

				return {
					id: tweet.id,
					tweetUrl: `https://twitter.com/i/status/${tweet.id}`,
					artist: user.username ? `@${user.username}` : user.firstName,
					date: tweet.createdAt.toISOString(),
					photos,
					// Pre-compute values for performance optimization
					photoCount: photos.length,
					firstPhotoId: photos[0]?.id,
					isMultiImage: photos.length > 1,
				};
			});

			// Create next cursor for infinite query
			let nextCursor = null;
			if (hasMore && tweetsToReturn.length > 0) {
				const lastTweet = tweetsToReturn[tweetsToReturn.length - 1];
				nextCursor = CursorPagination.createCursor({
					userId,
					lastTweetId: lastTweet.id,
					lastCreatedAt: lastTweet.createdAt.toISOString(),
					direction: "forward",
				});
			}

			return {
				success: true,
				tweets: transformedTweets,
				pagination: {
					hasNextPage: hasMore,
					hasPreviousPage: false, // For infinite scroll, we typically only go forward
					nextCursor,
					previousCursor: null,
				},
			};
		} catch (error) {
			console.error("Failed to fetch user tweets:", error);
			return {
				success: false,
				error: "Failed to fetch tweets",
				tweets: [],
				pagination: {
					hasNextPage: false,
					hasPreviousPage: false,
					nextCursor: null,
					previousCursor: null,
				},
			};
		}
	});

export { getUserTweets };

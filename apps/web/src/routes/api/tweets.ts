import { CursorPagination } from "@/lib/cursor-pagination";
import { getPrismaClient } from "@/utils";
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
			limit: z.number().min(1).max(50).default(20),
		}),
	)
	.handler(async ({ data }): Promise<UserTweetsResponse> => {
		const { telegramId, cursor, limit } = data;
		const userId = BigInt(telegramId);

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
					telegramId: userId,
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

			// Build where clause for cursor pagination
			const whereClause: {
				userId: string;
				createdAt?: {
					lt?: Date;
					gt?: Date;
				};
			} = {
				userId: user.id,
			};

			if (cursorData) {
				if (cursorData.direction === "forward") {
					whereClause.createdAt = {
						lt: new Date(cursorData.lastCreatedAt),
					};
				} else {
					whereClause.createdAt = {
						gt: new Date(cursorData.lastCreatedAt),
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
				orderBy: {
					createdAt: cursorData?.direction === "backward" ? "asc" : "desc",
				},
				take: limit + 1, // Fetch one extra to check if there are more
			});

			// Check if there are more tweets
			const hasMore = tweets.length > limit;
			const tweetsToReturn = hasMore ? tweets.slice(0, limit) : tweets;

			// Transform the data to match the expected format
			const transformedTweets: TweetData[] = tweetsToReturn.map((tweet) => ({
				id: tweet.id,
				tweetUrl: `https://twitter.com/i/status/${tweet.id}`,
				artist: user.username ? `@${user.username}` : user.firstName,
				date: tweet.createdAt.toISOString(),
				photos: tweet.photos.map((photo) => ({
					id: photo.id,
					// biome-ignore lint/style/noNonNullAssertion: We filter out photos with null s3Path
					url: photo.s3Url!,
					alt: `Photo from tweet ${tweet.id}`,
				})),
			}));

			// Create pagination info
			const pagination = CursorPagination.createPaginationInfo(
				tweetsToReturn,
				userId,
				hasMore,
				cursorData?.direction || "forward",
			);

			return {
				success: true,
				tweets: transformedTweets,
				pagination,
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

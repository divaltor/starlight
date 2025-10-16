import { ORPCError } from "@orpc/client";
import { logger, type Prisma, prisma, type User } from "@starlight/utils";
import { z } from "zod";
import { no } from "..";
import { maybeAuthProcedure } from "../middlewares/auth";
import type { TweetData } from "../types/tweets";
import { Cursor, type CursorPayload } from "../utils/cursor";

const TweetsQuery = z.object({
	username: z.string().optional(),
	cursor: z.string().optional(),
	limit: z.number().min(1).max(100).default(30),
});

export const listUserTweets = maybeAuthProcedure
	.input(TweetsQuery)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const { cursor, limit } = input;

		// Determine target user
		let targetUser: Pick<
			User,
			"id" | "telegramId" | "username" | "isPublic"
		> | null = null;

		if (input.username) {
			targetUser = await prisma.user.findUnique({
				where: { username: input.username },
				select: { id: true, telegramId: true, username: true, isPublic: true },
			});

			if (!targetUser) {
				throw new ORPCError("NOT_FOUND", {
					message: "User not found",
					status: 404,
				});
			}
		} else if (user) {
			// Own tweets (authenticated, no username provided)
			targetUser = await prisma.user.findUnique({
				where: { telegramId: user.id },
				select: { id: true, telegramId: true, username: true, isPublic: true },
			});
		} else {
			// Anonymous cannot request own tweets without specifying a username
			throw new ORPCError("UNAUTHORIZED", {
				message: "Unauthorized",
				status: 401,
			});
		}

		const isSelf = !!user && targetUser?.telegramId === BigInt(user.id);

		// Access control: only self or public profiles
		if (!(isSelf || targetUser?.isPublic)) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Unauthorized",
				status: 401,
			});
		}

		return await retrieveUserTweets({
			// biome-ignore lint/style/noNonNullAssertion: We know targetUser is not null
			userId: targetUser!.id,
			cursor,
			limit,
		});
	});

export const retrieveUserTweets = no
	.input(
		TweetsQuery.omit({ username: true }).extend({
			userId: z.string(),
		})
	)
	.handler(async ({ input }) => {
		const { userId, cursor, limit } = input;

		try {
			// Parse cursor if provided
			let cursorData: CursorPayload | null = null;
			if (cursor) {
				cursorData = Cursor.parse(cursor);

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
				// Filter by user id only
				userId,
			};

			if (cursorData) {
				const cursorDate = new Date(cursorData.createdAt);
				whereClause.OR = [
					{ createdAt: { lt: cursorDate } },
					{ createdAt: cursorDate, id: { lt: cursorData.lastTweetId } },
				];
			}

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

				const tweetData = tweet.tweetData;
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

			let nextCursor: string | null = null;
			if (tweets.length === limit) {
				// biome-ignore lint/style/noNonNullAssertion: We know there's at least one tweet
				const lastTweet = tweets.at(-1)!;
				nextCursor = Cursor.create({
					lastTweetId: lastTweet.id,
					createdAt: lastTweet.createdAt.toISOString(),
				});
			}

			return {
				tweets: transformedTweets,
				nextCursor,
			};
		} catch (error) {
			logger.error({ error }, "Failed to fetch user tweets");
			return {
				tweets: [],
				nextCursor: null,
			};
		}
	})
	.callable();

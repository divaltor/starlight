import { ORPCError } from "@orpc/client";
import { type Prisma, prisma, type User } from "@starlight/utils";
import { z } from "zod";
import { no } from "..";
import { maybeAuthProcedure } from "../middlewares/auth";
import { Cursor, type CursorPayload } from "../utils/cursor";
import { transformTweets } from "../utils/transformations";

const TweetsQuery = z.object({
	username: z.string().optional(),
	cursor: z.string().optional(),
	limit: z.number().min(1).max(100).default(30),
});

export const listUserTweets = maybeAuthProcedure
	.input(TweetsQuery)
	.route({ method: "GET" })
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
			let cursorData: CursorPayload | null = null;
			if (cursor) {
				cursorData = Cursor.parse(cursor);

				if (!cursorData) {
					return {
						tweets: [],
						nextCursor: null,
					};
				}
			}

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

			const transformedTweets = transformTweets(tweets);

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
		} catch {
			return {
				tweets: [],
				nextCursor: null,
			};
		}
	})
	.callable();

import { ORPCError } from "@orpc/client";
import { Prisma, prisma } from "@starlight/utils";
import type { Tweet, User } from "@starlight/utils";
import { z } from "zod";
import { no, publicProcedure } from "..";
import { maybeAuthProcedure, protectedProcedure } from "../middlewares/auth";
import { Cursor, CursorPayloadSchema } from "../utils/cursor";
import type { CursorPayload } from "../utils/cursor";
import { transformTweets } from "../utils/transformations";

const TweetsQuery = z.object({
  username: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(30),
});

export const listUserTweets = maybeAuthProcedure.input(TweetsQuery).handler(async ({ input, context }) => {
  const { user } = context;

  const { cursor, limit } = input;

  // Determine target user
  let targetUser: Pick<User, "id" | "telegramId" | "username" | "isPublic"> | null = null;

  if (input.username !== undefined && input.username !== "") {
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
  if (!(isSelf || targetUser?.isPublic === true)) {
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
    }),
  )
  .handler(async ({ input }) => {
    const { userId, cursor, limit } = input;

    try {
      let cursorData: CursorPayload | null = null;

      if (cursor !== undefined && cursor !== "") {
        cursorData = Cursor.parse(cursor, CursorPayloadSchema);

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

export const listArtistTweets = publicProcedure
  .input(TweetsQuery.omit({ username: true }).extend({ username: z.string().min(1) }))
  .handler(async ({ input }) => {
    const cursorData =
      input.cursor !== undefined && input.cursor !== "" ? Cursor.parse(input.cursor, CursorPayloadSchema) : undefined;

    if (cursorData === null) {
      return { tweets: [], nextCursor: null };
    }

    // The same tweet can be saved by several public users; keep one copy per tweet id.
    const page = await prisma.$queryRaw<Pick<Tweet, "id" | "userId" | "createdAt">[]>`
      SELECT id, "userId", "createdAt"
      FROM (
        SELECT DISTINCT ON (t.id) t.id, t.user_id AS "userId", t.created_at AS "createdAt"
        FROM tweets t
        JOIN users u ON u.id = t.user_id AND u.is_public
        WHERE t.username = ${input.username}
          AND EXISTS (
            SELECT 1 FROM photos p
            WHERE p.tweet_id = t.id AND p.user_id = t.user_id AND p.deleted_at IS NULL AND p.s3_path IS NOT NULL
          )
        ORDER BY t.id, t.user_id
      ) artist_tweets
      ${
        cursorData
          ? Prisma.sql`WHERE ("createdAt", id) < (${new Date(cursorData.createdAt)}, ${cursorData.lastTweetId})`
          : Prisma.empty
      }
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${input.limit}
    `;

    const tweets = await prisma.tweet.findMany({
      where: { OR: page.map((tweet) => ({ id: tweet.id, userId: tweet.userId })) },
      include: {
        photos: {
          where: prisma.photo.available(),
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const lastTweet = page.at(-1);

    return {
      tweets: transformTweets(tweets),
      nextCursor:
        lastTweet && page.length === input.limit
          ? Cursor.create({ lastTweetId: lastTweet.id, createdAt: lastTweet.createdAt.toISOString() })
          : null,
    };
  });

export const deletePhoto = protectedProcedure
  .input(z.object({ photoId: z.string() }))
  .handler(async ({ input, context }) => {
    const photo = await prisma.photo.findFirst({
      where: {
        id: input.photoId,
        userId: context.databaseUserId,
        deletedAt: null,
      },
    });

    if (!photo) {
      throw new ORPCError("NOT_FOUND", {
        message: "Photo not found",
        status: 404,
      });
    }

    await prisma.photo.update({
      where: {
        photoId: {
          id: input.photoId,
          userId: context.databaseUserId,
        },
      },
      data: { deletedAt: new Date() },
    });

    return { success: true };
  });

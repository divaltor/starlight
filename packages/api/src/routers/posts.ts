import { ORPCError } from "@orpc/client";
import { type Prisma, prisma, type User } from "@starlight/utils";
import { z } from "zod";
import { no } from "..";
import { maybeAuthProcedure, protectedProcedure } from "../middlewares/auth";
import { Cursor, CursorPayloadSchema, type CursorPayload } from "../utils/cursor";
import { parseMediaPublicId } from "../utils/public-id";
import { transformPosts } from "../utils/transformations";

const PostsQuery = z.object({
	username: z.string().optional(),
	cursor: z.string().optional(),
	limit: z.number().min(1).max(100).default(30),
});

export const listUserPosts = maybeAuthProcedure
	.input(PostsQuery)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const { cursor, limit } = input;

		// Determine target user
		let targetUser: Pick<User, "id" | "telegramId" | "username" | "isPublic"> | null = null;

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
			// Own posts (authenticated, no username provided)
			targetUser = await prisma.user.findUnique({
				where: { telegramId: user.id },
				select: { id: true, telegramId: true, username: true, isPublic: true },
			});
		} else {
			// Anonymous cannot request own posts without specifying a username
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

		return await retrieveUserPosts({
			// biome-ignore lint/style/noNonNullAssertion: We know targetUser is not null
			userId: targetUser!.id,
			cursor,
			limit,
		});
	});

export const retrieveUserPosts = no
	.input(
		PostsQuery.omit({ username: true }).extend({
			userId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		const { userId, cursor, limit } = input;

		try {
			let cursorData: CursorPayload | null = null;
			if (cursor) {
				cursorData = Cursor.parse(cursor, CursorPayloadSchema);

				if (!cursorData) {
					return {
						posts: [],
						nextCursor: null,
					};
				}
			}

			const whereClause: Prisma.PostWhereInput = {
				userId,
			};

			if (cursorData) {
				const cursorDate = new Date(cursorData.createdAt);
				whereClause.OR = [
					{ createdAt: { lt: cursorDate } },
					{ createdAt: cursorDate, id: { lt: cursorData.lastPostId } },
					{
						createdAt: cursorDate,
						id: cursorData.lastPostId,
						provider: { lt: cursorData.provider ?? "twitter" },
					},
				];
			}

			const posts = await prisma.post.findMany({
				where: {
					...whereClause,
					...prisma.post.available(),
				},
				include: {
					media: {
						where: prisma.media.available(),
						orderBy: [{ position: "asc" }, { id: "asc" }],
					},
				},
				orderBy: [
					{
						createdAt: "desc",
					},
					{
						id: "desc",
					},
					{ provider: "desc" },
				],
				take: limit,
			});

			const transformedPosts = transformPosts(posts);

			let nextCursor: string | null = null;
			if (posts.length === limit) {
				// biome-ignore lint/style/noNonNullAssertion: We know there's at least one post
				const lastPost = posts.at(-1)!;
				nextCursor = Cursor.create({
					lastPostId: lastPost.id,
					provider: lastPost.provider,
					createdAt: lastPost.createdAt.toISOString(),
				});
			}

			return {
				posts: transformedPosts,
				nextCursor,
			};
		} catch {
			return {
				posts: [],
				nextCursor: null,
			};
		}
	})
	.callable();

export const deleteMedia = protectedProcedure
	.input(z.object({ mediaId: z.string() }))
	.handler(async ({ input, context }) => {
		const mediaId = parseMediaPublicId(input.mediaId);
		if (!mediaId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid media ID",
				status: 400,
			});
		}
		const { provider, externalId, userId } = mediaId;
		if (userId && userId !== context.databaseUserId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Media not found",
				status: 404,
			});
		}
		const media = await prisma.media.findFirst({
			where: {
				id: externalId,
				provider,
				userId: context.databaseUserId,
				deletedAt: null,
			},
		});

		if (!media) {
			throw new ORPCError("NOT_FOUND", {
				message: "Media not found",
				status: 404,
			});
		}

		await prisma.media.update({
			where: {
				mediaId: {
					id: externalId,
					provider,
					userId: context.databaseUserId,
				},
			},
			data: { deletedAt: new Date() },
		});

		return { success: true };
	});

import { getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/middleware/auth";

export const getPostingChannel = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		const postingChannel = await prisma.postingChannel.findUnique({
			where: {
				userId,
			},
			include: {
				chat: true,
			},
		});

		return postingChannel;
	});

export const deletePostingChannel = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		try {
			await prisma.postingChannel.delete({
				where: {
					userId,
				},
			});

			return { success: true };
		} catch {
			return { success: false, error: "Failed to disconnect channel" };
		}
	});

export type PostingChannel = Awaited<ReturnType<typeof getPostingChannel>>;

import { getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/middleware/auth";

export const getPostingChannel = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		const postingChannel = await prisma.postingChannel.findFirst({
			where: {
				userId,
				isActive: true,
			},
			include: {
				chat: true,
			},
		});

		return postingChannel;
	});

export type PostingChannel = Awaited<ReturnType<typeof getPostingChannel>>;

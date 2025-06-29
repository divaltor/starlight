import { getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/middleware/auth";

export const getPostingChannels = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		const postingChannels = await prisma.postingChannel.findMany({
			where: {
				userId,
				isActive: true,
			},
			include: {
				chat: true,
			},
			orderBy: [{ createdAt: "desc" }, { chat: { title: "asc" } }],
		});

		return { postingChannels };
	});

import { ORPCError } from "@orpc/client";
import { prisma } from "@starlight/utils";
import { protectedProcedure } from "../middlewares/auth";

// Retrieves the user's posting channel (if connected) including related chat information.
export const getPostingChannel = protectedProcedure.handler(
	async ({ context }) => {
		const userId = context.databaseUserId;

		const postingChannel = await prisma.postingChannel.findUnique({
			where: { userId },
			include: { chat: true },
		});

		return postingChannel;
	}
);

// Deletes (disconnects) the user's posting channel.
export const deletePostingChannel = protectedProcedure.handler(
	async ({ context }) => {
		const userId = context.databaseUserId;

		try {
			await prisma.postingChannel.delete({
				where: { userId },
			});
		} catch {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to disconnect channel",
				status: 500,
			});
		}
	}
);

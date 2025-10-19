import { ORPCError } from "@orpc/client";
import { prisma } from "@starlight/utils";
import { protectedProcedure } from "../middlewares/auth";

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

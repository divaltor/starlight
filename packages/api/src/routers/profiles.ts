import { prisma } from "@starlight/utils";
import { z } from "zod";
import { protectedProcedure } from "../middlewares/auth";

export const changeProfileVisibility = protectedProcedure
	.input(
		z.object({
			status: z.enum(["public", "private"]),
		})
	)
	.route({ method: "PUT" })
	.handler(async ({ input, context }) => {
		const userId = context.databaseUserId;

		await prisma.user.update({
			where: { id: userId },
			data: { isPublic: input.status === "public" },
		});

		return { success: true };
	});

export const getUserProfile = protectedProcedure
	.route({ method: "GET" })
	.handler(async ({ context }) => {
		const userId = context.databaseUserId;

		const userProfile = await prisma.user.findUnique({
			where: { id: userId },
			select: {
				id: true,
				username: true,
				isPublic: true,
				createdAt: true,
				updatedAt: true,
			},
		});

		return userProfile;
	});

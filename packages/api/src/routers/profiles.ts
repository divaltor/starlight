import { ORPCError } from "@orpc/client";
import { prisma } from "@starlight/utils";
import { z } from "zod";
import { protectedProcedure } from "../middlewares/auth";
import { verifyCookies } from "./cookies";

export const changeProfileVisibility = protectedProcedure
	.input(
		z.object({
			status: z.enum(["public", "private"]),
		})
	)
	.handler(async ({ input, context }) => {
		const userId = context.databaseUserId;

		await prisma.user.update({
			where: { id: userId },
			data: { isPublic: input.status === "public" },
		});

		return { success: true };
	});

const UserProfileSchema = z.object({
	user: z.object({
		username: z.string(),
		isPublic: z.boolean(),
	}),
	hasValidCookies: z.boolean(),
	postingChannel: z
		.object({
			id: z.bigint(),
			title: z.string().nullable(),
			username: z.string().nullable(),
			photoThumbnail: z.string().optional(),
			photoBig: z.string().optional(),
		})
		.optional(),
});

export const getUserProfile = protectedProcedure
	.output(UserProfileSchema)
	.handler(async ({ context }) => {
		const userId = context.databaseUserId;

		const [userProfile, hasValidCookies, postingChannel] = await Promise.all([
			prisma.user.findUnique({
				where: { id: userId },
				select: {
					id: true,
					username: true,
					isPublic: true,
					createdAt: true,
					updatedAt: true,
				},
			}),
			verifyCookies({ context }),
			prisma.postingChannel.findUnique({
				where: { userId },
				include: { chat: true },
			}),
		]);

		if (!userProfile) {
			throw new ORPCError("NOT_FOUND", {
				message: "User not found",
				status: 404,
			});
		}

		if (!postingChannel) {
			return {
				user: {
					id: userProfile.id,
					username: userProfile.username ?? "",
					isPublic: userProfile.isPublic,
				},
				hasValidCookies: hasValidCookies.hasValidCookies,
			};
		}

		return {
			user: {
				id: userProfile.id,
				username: userProfile.username ?? "",
				isPublic: userProfile.isPublic,
			},
			hasValidCookies: hasValidCookies.hasValidCookies,
			postingChannel: {
				id: postingChannel?.chat.id,
				title: postingChannel?.chat.title,
				username: postingChannel?.chat.username,
				photoThumbnail: postingChannel?.chat.thumbnailUrl,
				photoBig: postingChannel?.chat.bigUrl,
			},
		};
	});

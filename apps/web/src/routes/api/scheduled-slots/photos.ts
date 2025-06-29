import { getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/middleware/auth";

const deletePhotoSchema = z.object({
	slotId: z.string().uuid(),
	photoId: z.string(),
});

const addPhotoSchema = z.object({
	slotId: z.string().uuid(),
	photoId: z.string(),
});

export const deletePhoto = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(deletePhotoSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const { slotId, photoId } = data;
		const userId = context.user.id.toString();

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: { id: slotId, userId },
		});

		if (!existingSlot) {
			throw new Error("Scheduled slot not found");
		}

		const scheduledSlotPhoto = await prisma.scheduledSlotPhoto.findFirst({
			where: {
				photoId,
				userId,
				scheduledSlotTweet: {
					scheduledSlotId: slotId,
				},
			},
			include: {
				scheduledSlotTweet: {
					include: {
						scheduledSlotPhotos: true,
					},
				},
			},
		});

		if (!scheduledSlotPhoto) {
			throw new Error("Photo not found in slot");
		}

		await prisma.scheduledSlotPhoto.delete({
			where: { id: scheduledSlotPhoto.id },
		});

		const remainingPhotos = await prisma.scheduledSlotPhoto.count({
			where: {
				scheduledSlotTweetId: scheduledSlotPhoto.scheduledSlotTweetId,
			},
		});

		if (remainingPhotos === 0) {
			await prisma.scheduledSlotTweet.delete({
				where: { id: scheduledSlotPhoto.scheduledSlotTweetId },
			});
		}

		const remainingTweets = await prisma.scheduledSlotTweet.count({
			where: {
				scheduledSlotId: slotId,
			},
		});

		if (remainingTweets === 0) {
			await prisma.scheduledSlot.delete({
				where: { id: slotId },
			});
			return { success: true, slotDeleted: true };
		}

		const updatedSlot = await prisma.scheduledSlot.findUnique({
			where: { id: slotId },
			include: {
				scheduledSlotTweets: {
					include: {
						tweet: true,
						scheduledSlotPhotos: {
							include: {
								photo: true,
							},
						},
					},
				},
			},
		});

		return { success: true, slot: updatedSlot };
	});

export const addPhoto = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(addPhotoSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const { slotId, photoId } = data;
		const userId = context.user.id.toString();

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: { id: slotId, userId },
		});

		if (!existingSlot) {
			throw new Error("Scheduled slot not found");
		}

		const scheduledSlotPhoto = await prisma.scheduledSlotPhoto.findFirst({
			where: {
				photoId,
				userId,
				scheduledSlotTweet: {
					scheduledSlotId: slotId,
				},
			},
			include: {
				scheduledSlotTweet: {
					include: {
						scheduledSlotPhotos: true,
					},
				},
			},
		});

		if (!scheduledSlotPhoto) {
			throw new Error("Photo not found in slot");
		}

		await prisma.scheduledSlotPhoto.delete({
			where: { id: scheduledSlotPhoto.id },
		});

		const remainingPhotos = await prisma.scheduledSlotPhoto.count({
			where: {
				scheduledSlotTweetId: scheduledSlotPhoto.scheduledSlotTweetId,
			},
		});

		if (remainingPhotos === 0) {
			await prisma.scheduledSlotTweet.delete({
				where: { id: scheduledSlotPhoto.scheduledSlotTweetId },
			});
		}

		const remainingTweets = await prisma.scheduledSlotTweet.count({
			where: {
				scheduledSlotId: slotId,
			},
		});

		if (remainingTweets === 0) {
			await prisma.scheduledSlot.delete({
				where: { id: slotId },
			});
			return { success: true, slotDeleted: true };
		}

		const updatedSlot = await prisma.scheduledSlot.findUnique({
			where: { id: slotId },
			include: {
				scheduledSlotTweets: {
					include: {
						tweet: true,
						scheduledSlotPhotos: {
							include: {
								photo: true,
							},
						},
					},
				},
			},
		});

		return { success: true, slot: updatedSlot };
	});

import { getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/middleware/auth";

const getScheduledSlotsSchema = z.object({
	postingChannelId: z.number().optional(),
});

const createSlotSchema = z.object({
	scheduledFor: z.string().datetime(),
	tweetCount: z.number().min(1).max(5).default(3),
	postingChannelId: z.number(),
});

const updateSlotSchema = z.object({
	slotId: z.string().uuid(),
	status: z.enum(["waiting", "published", "done"]).optional(),
	postingChannelId: z.number().optional(),
});

const deleteSlotSchema = z.object({
	slotId: z.string().uuid(),
	postingChannelId: z.number().optional(),
});

export const getScheduledSlots = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator(getScheduledSlotsSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const userId = context.user.id.toString();
		const { postingChannelId } = data;

		// biome-ignore lint/suspicious/noExplicitAny: Need to export types from Prisma, don't want to do that
		const whereClause: any = { userId };
		if (postingChannelId) {
			whereClause.chatId = postingChannelId;
		}

		const slots = await prisma.scheduledSlot.findMany({
			where: whereClause,
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
			orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
		});

		return { slots };
	});

export const createScheduledSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(createSlotSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const { scheduledFor, tweetCount, postingChannelId } = data;
		const userId = context.user.id.toString();

		// Check if user exists and get posting channel
		const postingChannel = await prisma.postingChannel.findUnique({
			where: {
				userId_chatId: {
					userId,
					chatId: postingChannelId,
				},
			},
		});

		if (!postingChannel || postingChannel.userId !== userId) {
			throw new Error("Posting channel not found or access denied");
		}

		// Get available tweets with unpublished photos for this channel
		const availableTweets = await prisma.tweet.findMany({
			where: {
				userId,
				photos: {
					some: {
						deletedAt: null,
						s3Path: { not: null },
						publishedPhotos: {
							none: {
								chatId: postingChannel.chatId,
							},
						},
						scheduledSlotPhotos: { none: {} },
					},
				},
			},
			include: {
				photos: {
					where: {
						deletedAt: null,
						s3Path: { not: null },
						publishedPhotos: {
							none: {
								chatId: postingChannel.chatId,
							},
						},
						scheduledSlotPhotos: { none: {} },
					},
				},
			},
			orderBy: { createdAt: "desc" },
			take: tweetCount * 2, // Get more tweets for random selection
		});

		if (availableTweets.length === 0) {
			throw new Error("No tweets with unpublished photos available");
		}

		// Randomly select tweets
		const selectedTweets = availableTweets
			.sort(() => Math.random() - 0.5)
			.slice(0, Math.min(tweetCount, availableTweets.length));

		// Create the scheduled slot
		const scheduledSlot = await prisma.scheduledSlot.create({
			data: {
				userId,
				chatId: postingChannelId,
				scheduledFor: new Date(scheduledFor),
				status: "waiting",
			},
		});

		// Create scheduled slot tweets and their photos
		for (const tweet of selectedTweets) {
			const scheduledSlotTweet = await prisma.scheduledSlotTweet.create({
				data: {
					scheduledSlotId: scheduledSlot.id,
					tweetId: tweet.id,
					userId,
				},
			});

			// Add all available photos from this tweet
			for (const photo of tweet.photos) {
				await prisma.scheduledSlotPhoto.create({
					data: {
						scheduledSlotTweetId: scheduledSlotTweet.id,
						photoId: photo.id,
						userId,
					},
				});
			}
		}

		// Fetch the complete slot with relations
		const completeSlot = await prisma.scheduledSlot.findUnique({
			where: { id: scheduledSlot.id },
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

		return { slot: completeSlot };
	});

export const updateScheduledSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(updateSlotSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const { slotId, status, postingChannelId } = data;
		const userId = context.user.id.toString();

		// Verify slot belongs to user and optionally postingChannelId
		// biome-ignore lint/suspicious/noExplicitAny: Need to export types from Prisma, don't want to do that
		const whereClause: any = { id: slotId, userId };
		if (postingChannelId) {
			whereClause.postingChannelId = postingChannelId;
		}

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: whereClause,
		});

		if (!existingSlot) {
			throw new Error("Scheduled slot not found");
		}

		const updatedSlot = await prisma.scheduledSlot.update({
			where: { id: slotId },
			data: {
				...(status && { status }),
			},
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

		return { slot: updatedSlot };
	});

export const deleteScheduledSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(deleteSlotSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const { slotId, postingChannelId } = data;
		const userId = context.user.id.toString();

		// Verify slot belongs to user and optionally postingChannelId
		// biome-ignore lint/suspicious/noExplicitAny: Need to export types from Prisma, don't want to do that
		const whereClause: any = { id: slotId, userId };
		if (postingChannelId) {
			whereClause.postingChannelId = postingChannelId;
		}

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: whereClause,
		});

		if (!existingSlot) {
			throw new Error("Scheduled slot not found");
		}

		// Delete the slot (this will set scheduledSlotId to null in related publishedPhotos due to SetNull)
		await prisma.scheduledSlot.delete({
			where: { id: slotId },
		});

		return { success: true };
	});

// Helper functions for slot management
export async function getAvailablePhotosForUser(
	userId: string,
	postingChannelId?: number,
	limit = 20,
) {
	const prisma = getPrismaClient();

	// biome-ignore lint/suspicious/noExplicitAny: Need to export types from Prisma, don't want to do that
	let publishedPhotosFilter: any = { none: {} };

	if (postingChannelId) {
		// Get the chatId from the posting channel
		const postingChannel = await prisma.postingChannel.findUnique({
			where: {
				userId_chatId: {
					userId,
					chatId: postingChannelId,
				},
			},
		});

		if (postingChannel) {
			publishedPhotosFilter = { none: { chatId: postingChannel.chatId } };
		}
	}

	return await prisma.photo.findMany({
		where: {
			userId,
			deletedAt: null,
			s3Path: { not: null },
			publishedPhotos: publishedPhotosFilter,
		},
		include: {
			tweet: true,
		},
		orderBy: { createdAt: "desc" },
		take: limit,
	});
}

export async function createScheduledSlotForToday(
	userId: string,
	postingChannelId: number,
) {
	const prisma = getPrismaClient();

	const today = new Date();
	today.setHours(
		9 + Math.floor(Math.random() * 14),
		Math.floor(Math.random() * 60),
		0,
		0,
	);

	// Check if there's already a slot for today
	const startOfDay = new Date();
	startOfDay.setHours(0, 0, 0, 0);
	const endOfDay = new Date();
	endOfDay.setHours(23, 59, 59, 999);

	const existingSlot = await prisma.scheduledSlot.findFirst({
		where: {
			userId,
			chatId: postingChannelId,
			scheduledFor: {
				gte: startOfDay,
				lte: endOfDay,
			},
		},
	});

	if (existingSlot) {
		// If today is taken, schedule for tomorrow
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate() + 1);
		today.setTime(tomorrow.getTime());
	}

	return await prisma.scheduledSlot.create({
		data: {
			userId,
			chatId: postingChannelId,
			scheduledFor: today,
			status: "waiting",
		},
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
}

export async function reshuffleSlotPhotos(
	slotId: string,
	userId: string,
	postingChannelId?: number,
) {
	const prisma = getPrismaClient();

	const whereClause: any = { id: slotId, userId };
	if (postingChannelId) {
		whereClause.postingChannelId = postingChannelId;
	}

	const slot = await prisma.scheduledSlot.findFirst({
		where: whereClause,
		include: {
			scheduledSlotTweets: {
				include: {
					scheduledSlotPhotos: true,
				},
			},
		},
	});

	if (!slot) {
		throw new Error("Slot not found");
	}

	// Get current photo count
	const currentPhotoCount = slot.scheduledSlotTweets.reduce(
		(total: number, tweet: any) => total + tweet.scheduledSlotPhotos.length,
		0,
	);

	// Get new random photos
	const availablePhotos = await getAvailablePhotosForUser(
		userId,
		postingChannelId,
		currentPhotoCount * 2,
	);

	if (availablePhotos.length === 0) {
		throw new Error("No available photos for reshuffling");
	}

	// This would require additional logic to manage the relationship
	// between scheduled slots and photos since we don't have a direct
	// many-to-many relationship in the current schema

	return slot;
}

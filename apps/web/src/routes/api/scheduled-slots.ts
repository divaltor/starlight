import { getPrismaClient, type Prisma, ScheduledSlotStatus } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod/v4";
import { authMiddleware } from "@/middleware/auth";

const getScheduledSlotsSchema = z.object({
	status: z
		.enum([
			ScheduledSlotStatus.WAITING,
			ScheduledSlotStatus.PUBLISHED,
			ScheduledSlotStatus.PUBLISHING,
		])
		.optional(),
	limit: z.number().min(1).max(30).default(10),
});

const createSlotSchema = z.object({
	scheduledFor: z.iso.datetime().optional(),
	tweetCount: z.number().min(1).max(10).default(5),
});

const updateSlotSchema = z.object({
	slotId: z.uuid(),
	status: z
		.enum([ScheduledSlotStatus.PUBLISHED, ScheduledSlotStatus.PUBLISHING])
		.optional(),
});

const deleteSlotSchema = z.object({
	slotId: z.uuid(),
});

const shuffleTweetSchema = z.object({
	slotId: z.uuid(),
	tweetId: z.uuid(),
});

const addTweetSchema = z.object({
	slotId: z.uuid(),
});

export const getScheduledSlots = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator(getScheduledSlotsSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;
		const { status, limit } = data;

		const whereClause: Prisma.ScheduledSlotWhereInput = { userId };

		if (status) {
			whereClause.status = status;
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
							orderBy: { createdAt: "asc" },
						},
					},
					orderBy: { createdAt: "asc" },
				},
			},
			orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
			take: limit,
		});

		return slots;
	});

export type ScheduledSlots = Awaited<ReturnType<typeof getScheduledSlots>>;
export type ScheduledSlot = ScheduledSlots[number];
export type ScheduledSlotWithTweets = ScheduledSlot["scheduledSlotTweets"];
export type ScheduledSlotTweet = ScheduledSlotWithTweets[number];
export type ScheduledSlotTweetWithPhotos =
	ScheduledSlotTweet["scheduledSlotPhotos"];
export type ScheduledSlotTweetPhoto = ScheduledSlotTweetWithPhotos[number];

export const createScheduledSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(createSlotSchema)
	.handler(async ({ data, context }) => {
		const { scheduledFor, tweetCount } = data;

		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		// Check if user exists and get posting channel
		const postingChannel = await prisma.postingChannel.findUnique({
			where: {
				userId,
			},
		});

		if (!postingChannel) {
			setResponseStatus(404);
			return { slot: null, error: "Posting channel not found" };
		}

		// Get available tweets with unpublished photos for this channel
		const availableTweets = await prisma.tweet.findMany({
			where: {
				userId,
				photos: {
					some: {
						...prisma.photo.unpublished(postingChannel.chatId),
					},
				},
			},
			include: {
				photos: {
					where: {
						...prisma.photo.unpublished(postingChannel.chatId),
					},
				},
			},
			orderBy: [{ createdAt: "desc" }, { id: "asc" }],
			take: tweetCount * 2, // Get more tweets for random selection
		});

		if (availableTweets.length === 0) {
			setResponseStatus(400);
			return {
				slot: null,
				error: "No tweets with unpublished photos available",
			};
		}

		// Randomly select tweets
		const selectedTweets = availableTweets
			.sort(() => Math.random() - 0.5)
			.slice(0, Math.min(tweetCount, availableTweets.length));

		const createdSlot = await prisma.$transaction(async (tx) => {
			const createdSlot = await tx.scheduledSlot.create({
				data: {
					userId,
					chatId: postingChannel.chatId,
					scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
				},
			});

			for (const tweet of selectedTweets) {
				const scheduledSlotTweet = await tx.scheduledSlotTweet.create({
					data: {
						scheduledSlotId: createdSlot.id,
						tweetId: tweet.id,
						userId,
					},
				});

				await tx.scheduledSlotPhoto.createMany({
					data: tweet.photos.map((photo) => ({
						scheduledSlotTweetId: scheduledSlotTweet.id,
						photoId: photo.id,
						userId,
					})),
				});
			}

			return createdSlot;
		});

		const slot = await prisma.scheduledSlot.findUnique({
			where: { id: createdSlot.id },
			include: {
				scheduledSlotTweets: {
					include: {
						tweet: true,
						scheduledSlotPhotos: {
							include: { photo: true },
							orderBy: { createdAt: "asc" },
						},
					},
					orderBy: { createdAt: "asc" },
				},
			},
		});

		return { slot, error: null };
	});

export const updateScheduledSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(updateSlotSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const { slotId, status } = data;
		const userId = context.databaseUserId;

		// Verify slot belongs to user and optionally postingChannelId
		const whereClause: Prisma.ScheduledSlotWhereInput = { id: slotId, userId };

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: whereClause,
		});

		if (!existingSlot) {
			setResponseStatus(404);
			return { slot: null, error: "Scheduled slot not found" };
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
							orderBy: { createdAt: "asc" },
						},
					},
					orderBy: { createdAt: "asc" },
				},
			},
		});

		return { slot: updatedSlot, error: null };
	});

export const deleteScheduledSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(deleteSlotSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const { slotId } = data;
		const userId = context.databaseUserId;

		// Verify slot belongs to user and optionally postingChannelId
		const whereClause: Prisma.ScheduledSlotWhereInput = {
			id: slotId,
			userId,
			status: ScheduledSlotStatus.WAITING,
		};

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: whereClause,
		});

		if (!existingSlot) {
			setResponseStatus(404);
			return { success: false, error: "Scheduled slot not found" };
		}

		// Delete the slot (this will set scheduledSlotId to null in related publishedPhotos due to SetNull)
		await prisma.scheduledSlot.delete({
			where: { id: slotId },
		});

		return { success: true, error: null };
	});

export const shuffleTweet = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(shuffleTweetSchema)
	.handler(async ({ data, context }) => {
		const { slotId, tweetId } = data;
		const userId = context.databaseUserId;

		const updatedSlot = await shuffleSlotTweet(slotId, tweetId, userId);

		return { slot: updatedSlot, error: null };
	});

export const addTweetToSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(addTweetSchema)
	.handler(async ({ data, context }) => {
		const { slotId } = data;
		const userId = context.databaseUserId;

		const updatedSlot = await addRandomTweetToSlot(slotId, userId);

		return { slot: updatedSlot, error: null };
	});

export async function shuffleSlotTweet(
	slotId: string,
	tweetId: string,
	userId: string
) {
	"use server";

	const prisma = getPrismaClient();

	const whereClause: Prisma.ScheduledSlotWhereInput = { id: slotId, userId };

	const slot = await prisma.scheduledSlot.findFirst({
		where: whereClause,
		include: {
			scheduledSlotTweets: {
				include: {
					scheduledSlotPhotos: {
						include: {
							photo: true,
						},
						orderBy: { createdAt: "asc" },
					},
					tweet: true,
				},
				orderBy: { createdAt: "asc" },
			},
		},
	});

	if (!slot) {
		setResponseStatus(404);
		return { slot: null, error: "Slot not found" };
	}

	// Find the specific tweet in the slot
	const slotTweet = slot.scheduledSlotTweets.find((st) => st.id === tweetId);
	if (!slotTweet) {
		setResponseStatus(404);
		return { slot: null, error: "Tweet not found in slot" };
	}

	// Get currently used tweet IDs in this slot to avoid duplicates
	const currentTweetIds = slot.scheduledSlotTweets.map((st) => st.tweet.id);

	// Get available tweets with unpublished photos (excluding currently used tweets)
	const availableTweets = await prisma.tweet.findMany({
		where: {
			userId,
			id: { notIn: currentTweetIds }, // Exclude currently used tweets
			photos: {
				some: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		include: {
			photos: {
				where: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		orderBy: { createdAt: "desc" },
		take: 20, // Get multiple options for random selection
	});

	if (availableTweets.length === 0) {
		setResponseStatus(400);
		return { slot: null, error: "No available tweets for shuffling" };
	}

	// Select a random tweet
	const newTweet =
		availableTweets[Math.floor(Math.random() * availableTweets.length)];

	// Remove existing photos for this slot tweet
	await prisma.scheduledSlotPhoto.deleteMany({
		where: {
			scheduledSlotTweetId: tweetId,
		},
	});

	// Update the slot tweet to use the new tweet
	await prisma.scheduledSlotTweet.update({
		where: { id: tweetId },
		data: {
			tweetId: newTweet.id,
		},
	});

	// Add photos from the new tweet
	await prisma.scheduledSlotPhoto.createMany({
		data: newTweet.photos.map((photo) => ({
			scheduledSlotTweetId: tweetId,
			photoId: photo.id,
			userId,
		})),
	});

	// Return updated slot
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
						orderBy: { createdAt: "asc" },
					},
				},
				orderBy: { createdAt: "asc" },
			},
		},
	});

	return updatedSlot;
}

export async function addRandomTweetToSlot(slotId: string, userId: string) {
	"use server";

	const prisma = getPrismaClient();

	// Verify slot belongs to user and get current state
	const whereClause: Prisma.ScheduledSlotWhereInput = { id: slotId, userId };

	const slot = await prisma.scheduledSlot.findFirst({
		where: whereClause,
		include: {
			scheduledSlotTweets: {
				include: {
					tweet: true,
				},
			},
		},
	});

	if (!slot) {
		setResponseStatus(404);
		return { slot: null, error: "Slot not found" };
	}

	// Check if slot already has maximum tweets (10)
	if (slot.scheduledSlotTweets.length >= 10) {
		setResponseStatus(400);
		return { slot: null, error: "Slot already has maximum number of tweets" };
	}

	// Get currently used tweet IDs in this slot to avoid duplicates
	const currentTweetIds = slot.scheduledSlotTweets.map((st) => st.tweet.id);

	// Get available tweets with unpublished photos (excluding currently used tweets)
	const availableTweets = await prisma.tweet.findMany({
		where: {
			userId,
			id: { notIn: currentTweetIds }, // Exclude currently used tweets
			photos: {
				some: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		include: {
			photos: {
				where: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		orderBy: { createdAt: "desc" },
		take: 100, // Get multiple options for random selection
	});

	if (availableTweets.length === 0) {
		setResponseStatus(400);
		return { slot: null, error: "No available tweets to add" };
	}

	// Select a random tweet
	const randomTweet =
		availableTweets[Math.floor(Math.random() * availableTweets.length)];

	// Create the scheduled slot tweet
	const scheduledSlotTweet = await prisma.scheduledSlotTweet.create({
		data: {
			scheduledSlotId: slotId,
			tweetId: randomTweet.id,
			userId,
		},
	});

	// Add all available photos from this tweet
	await prisma.scheduledSlotPhoto.createMany({
		data: randomTweet.photos.map((photo) => ({
			scheduledSlotTweetId: scheduledSlotTweet.id,
			photoId: photo.id,
			userId,
		})),
	});

	// Return updated slot
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
						orderBy: { createdAt: "asc" },
					},
				},
				orderBy: { createdAt: "asc" },
			},
		},
	});

	return updatedSlot;
}

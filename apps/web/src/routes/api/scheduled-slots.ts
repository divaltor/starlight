import { getPrismaClient, type Prisma, ScheduledSlotStatus } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/middleware/auth";

const getScheduledSlotsSchema = z.object({
	postingChannelId: z.number().optional(),
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
	scheduledFor: z.string().datetime(),
	tweetCount: z.number().min(1).max(10).default(5),
	postingChannelId: z.number().optional(),
});

const updateSlotSchema = z.object({
	slotId: z.string().uuid(),
	status: z
		.enum([ScheduledSlotStatus.PUBLISHED, ScheduledSlotStatus.PUBLISHING])
		.optional(),
	postingChannelId: z.number().optional(),
});

const deleteSlotSchema = z.object({
	slotId: z.string().uuid(),
	postingChannelId: z.number().optional(),
});

const shuffleTweetSchema = z.object({
	slotId: z.string().uuid(),
	tweetId: z.string().uuid(),
	postingChannelId: z.number().optional(),
});

const addTweetSchema = z.object({
	slotId: z.string().uuid(),
	postingChannelId: z.number().optional(),
});

export const getScheduledSlots = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator(getScheduledSlotsSchema)
	.handler(async ({ data, context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;
		const { postingChannelId, status, limit } = data;

		const whereClause: Prisma.ScheduledSlotWhereInput = { userId };
		if (postingChannelId) {
			whereClause.chatId = postingChannelId;
		}

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

export const createScheduledSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(createSlotSchema)
	.handler(async ({ data, context }) => {
		const { scheduledFor, tweetCount, postingChannelId } = data;

		if (!postingChannelId) {
			throw new Error("Posting channel ID is required");
		}

		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

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
				status: ScheduledSlotStatus.WAITING,
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
							orderBy: { createdAt: "asc" },
						},
					},
					orderBy: { createdAt: "asc" },
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
		const userId = context.databaseUserId;

		// Verify slot belongs to user and optionally postingChannelId
		const whereClause: Prisma.ScheduledSlotWhereInput = { id: slotId, userId };
		if (postingChannelId) {
			whereClause.postingChannel = { chatId: postingChannelId };
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
							orderBy: { createdAt: "asc" },
						},
					},
					orderBy: { createdAt: "asc" },
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
		const userId = context.databaseUserId;

		// Verify slot belongs to user and optionally postingChannelId
		const whereClause: Prisma.ScheduledSlotWhereInput = {
			id: slotId,
			userId,
			status: ScheduledSlotStatus.WAITING,
		};
		if (postingChannelId) {
			whereClause.postingChannel = { chatId: postingChannelId };
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

export const shuffleTweet = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(shuffleTweetSchema)
	.handler(async ({ data, context }) => {
		const { slotId, tweetId, postingChannelId } = data;
		const userId = context.databaseUserId;

		const updatedSlot = await shuffleSlotTweet(
			slotId,
			tweetId,
			userId,
			postingChannelId,
		);

		return { slot: updatedSlot };
	});

export const addTweetToSlot = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(addTweetSchema)
	.handler(async ({ data, context }) => {
		const { slotId, postingChannelId } = data;
		const userId = context.databaseUserId;

		const updatedSlot = await addRandomTweetToSlot(
			slotId,
			userId,
			postingChannelId,
		);

		return { slot: updatedSlot };
	});

// Helper functions for slot management
export async function getAvailablePhotosForUser(
	userId: string,
	postingChannelId?: number,
	limit = 20,
) {
	const prisma = getPrismaClient();

	let publishedPhotosFilter: Prisma.PublishedPhotoListRelationFilter = {
		none: {},
	};

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
			publishedPhotosFilter = {
				none: { chatId: postingChannel.chatId },
			};
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
			status: ScheduledSlotStatus.WAITING,
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
}

export async function shuffleSlotTweet(
	slotId: string,
	tweetId: string,
	userId: string,
	postingChannelId?: number,
) {
	const prisma = getPrismaClient();

	const whereClause: Prisma.ScheduledSlotWhereInput = { id: slotId, userId };
	if (postingChannelId) {
		whereClause.postingChannel = { chatId: postingChannelId };
	}

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
		throw new Error("Slot not found");
	}

	// Find the specific tweet in the slot
	const slotTweet = slot.scheduledSlotTweets.find((st) => st.id === tweetId);
	if (!slotTweet) {
		throw new Error("Tweet not found in slot");
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
					publishedPhotos: postingChannelId
						? {
								none: { chatId: postingChannelId },
							}
						: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		include: {
			photos: {
				where: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: postingChannelId
						? {
								none: { chatId: postingChannelId },
							}
						: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		orderBy: { createdAt: "desc" },
		take: 20, // Get multiple options for random selection
	});

	if (availableTweets.length === 0) {
		throw new Error("No available tweets for shuffling");
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

export async function addRandomTweetToSlot(
	slotId: string,
	userId: string,
	postingChannelId?: number,
) {
	const prisma = getPrismaClient();

	// Verify slot belongs to user and get current state
	const whereClause: Prisma.ScheduledSlotWhereInput = { id: slotId, userId };
	if (postingChannelId) {
		whereClause.postingChannel = { chatId: postingChannelId };
	}

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
		throw new Error("Slot not found");
	}

	// Check if slot already has maximum tweets (10)
	if (slot.scheduledSlotTweets.length >= 10) {
		throw new Error("Slot already has maximum number of tweets");
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
					publishedPhotos: postingChannelId
						? {
								none: { chatId: postingChannelId },
							}
						: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		include: {
			photos: {
				where: {
					deletedAt: null,
					s3Path: { not: null },
					publishedPhotos: postingChannelId
						? {
								none: { chatId: postingChannelId },
							}
						: { none: {} },
					scheduledSlotPhotos: { none: {} },
				},
			},
		},
		orderBy: { createdAt: "desc" },
		take: 20, // Get multiple options for random selection
	});

	if (availableTweets.length === 0) {
		throw new Error("No available tweets to add");
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

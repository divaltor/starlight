import { ORPCError } from "@orpc/client";
import { type Prisma, prisma, ScheduledSlotStatus } from "@starlight/utils";
import { z } from "zod";
import { publicProcedure } from "..";
import type { Context } from "../context";
import { type AuthContext, protectedProcedure } from "../middlewares/auth";

const slotPhotoSchema = z.object({
	slotId: z.uuid(),
	photoId: z.string(),
});

const slotContext = publicProcedure
	.$context<Context & AuthContext>()
	.middleware(async ({ context, next }, { slotId }: { slotId: string }) => {
		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: { id: slotId, userId: context.databaseUserId },
		});

		if (!existingSlot) {
			throw new ORPCError("NOT_FOUND", {
				message: "Scheduled slot not found",
				status: 404,
			});
		}

		return next();
	});

export const scheduledSlotRemovePhoto = protectedProcedure
	.input(slotPhotoSchema)
	.use(slotContext)
	.handler(async ({ input, context }) => {
		const { slotId, photoId } = input;
		const userId = context.databaseUserId;

		const scheduledSlotPhoto = await prisma.scheduledSlotPhoto.findFirst({
			where: {
				photoId,
				userId,
				scheduledSlotTweet: { scheduledSlotId: slotId },
			},
			include: {
				scheduledSlotTweet: { include: { scheduledSlotPhotos: true } },
			},
		});
		if (!scheduledSlotPhoto) {
			throw new ORPCError("NOT_FOUND", {
				message: "Photo not found in slot",
				status: 404,
			});
		}

		await prisma.scheduledSlotPhoto.delete({
			where: { id: scheduledSlotPhoto.id },
		});

		const remainingPhotos = await prisma.scheduledSlotPhoto.count({
			where: { scheduledSlotTweetId: scheduledSlotPhoto.scheduledSlotTweetId },
		});
		if (remainingPhotos === 0) {
			await prisma.scheduledSlotTweet.delete({
				where: { id: scheduledSlotPhoto.scheduledSlotTweetId },
			});
		}

		const remainingTweets = await prisma.scheduledSlotTweet.count({
			where: { scheduledSlotId: slotId },
		});
		if (remainingTweets === 0) {
			await prisma.scheduledSlot.delete({ where: { id: slotId } });
		}

		const updatedSlot = await prisma.scheduledSlot.findUnique({
			where: { id: slotId },
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

		return updatedSlot;
	});

const getScheduledSlotsSchema = z.object({
	status: z
		.enum([
			ScheduledSlotStatus.WAITING,
			ScheduledSlotStatus.PUBLISHED,
			ScheduledSlotStatus.PUBLISHING,
		])
		.optional(),
});

const createSlotSchema = z.object({
	scheduledFor: z.string().datetime().optional(),
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

const addTweetSchema = z.object({
	slotId: z.uuid(),
});

export const getScheduledSlot = protectedProcedure
	.input(getScheduledSlotsSchema)
	.handler(async ({ input, context }) => {
		const userId = context.databaseUserId;
		const { status } = input;

		const whereClause: Prisma.ScheduledSlotWhereInput = { userId };

		if (status) {
			whereClause.status = status;
		}

		const slot = await prisma.scheduledSlot.findFirst({
			where: whereClause,
			include: {
				postingChannel: { include: { chat: true } },
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
			orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
		});

		return slot;
	});

export const createScheduledSlot = protectedProcedure
	.input(createSlotSchema)
	.handler(async ({ input, context }) => {
		const { scheduledFor, tweetCount } = input;
		const userId = context.databaseUserId;

		const postingChannel = await prisma.postingChannel.findUnique({
			where: { userId },
		});

		if (!postingChannel) {
			throw new ORPCError("NOT_FOUND", {
				message: "Posting channel not found, did you connect your channel?",
				status: 404,
			});
		}

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: {
				userId,
				chatId: postingChannel.chatId,
				status: ScheduledSlotStatus.WAITING,
			},
		});

		if (existingSlot) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Cannot create a new slot while there is a pending one",
				status: 400,
			});
		}

		const availableTweets = await prisma.tweet.findMany({
			where: {
				userId,
				photos: {
					some: { ...prisma.photo.unpublished(postingChannel.chatId) },
				},
			},
			include: {
				photos: {
					where: { ...prisma.photo.unpublished(postingChannel.chatId) },
				},
			},
			orderBy: [{ createdAt: "desc" }, { id: "asc" }],
			take: tweetCount * 2,
		});

		const selectedTweets = availableTweets
			.sort(() => Math.random() - 0.5)
			.slice(0, Math.min(tweetCount, availableTweets.length));

		const createdSlot = await prisma.$transaction(async (tx) => {
			const slot = await tx.scheduledSlot.create({
				data: {
					userId,
					chatId: postingChannel.chatId,
					scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
				},
			});

			for (const tweet of selectedTweets) {
				const scheduledSlotTweet = await tx.scheduledSlotTweet.create({
					data: {
						scheduledSlotId: slot.id,
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
			return slot;
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

		return slot;
	});

export const updateScheduledSlot = protectedProcedure
	.input(updateSlotSchema)
	.use(slotContext)
	.handler(async ({ input }) => {
		const { status } = input;

		const updatedSlot = await prisma.scheduledSlot.update({
			where: { id: input.slotId },
			data: { ...(status && { status }) },
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
		return updatedSlot;
	});

export const deleteScheduledSlot = protectedProcedure
	.input(deleteSlotSchema)
	.handler(async ({ input, context }) => {
		const { slotId } = input;
		const userId = context.databaseUserId;

		const existingSlot = await prisma.scheduledSlot.findFirst({
			where: { id: slotId, userId, status: ScheduledSlotStatus.WAITING },
		});

		if (!existingSlot) {
			throw new ORPCError("NOT_FOUND", {
				message: "Scheduled slot not found",
				status: 404,
			});
		}

		await prisma.scheduledSlot.delete({ where: { id: slotId } });
	});

async function getSlotWithTweets(slotId: string, userId: string) {
	const slot = await prisma.scheduledSlot.findFirst({
		where: { id: slotId, userId },
		include: {
			scheduledSlotTweets: {
				include: {
					tweet: true,
					scheduledSlotPhotos: { include: { photo: true } },
				},
			},
		},
	});

	if (!slot) {
		throw new ORPCError("NOT_FOUND", {
			message: "Slot not found",
			status: 404,
		});
	}

	return slot;
}

async function getAvailableTweets(userId: string, excludeTweetIds: string[]) {
	return await prisma.tweet.findMany({
		where: {
			userId,
			id: { notIn: excludeTweetIds },
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
		take: 50,
	});
}

function pickRandom<T>(items: T[]): T {
	// biome-ignore lint/style/noNonNullAssertion: Guaranteed to be non-null
	return items[Math.floor(Math.random() * items.length)]!;
}

async function shuffleSlotTweet({
	slotId,
	tweetId,
	userId,
}: {
	slotId: string;
	tweetId: string;
	userId: string;
}) {
	const slot = await getSlotWithTweets(slotId, userId);

	const slotTweet = slot.scheduledSlotTweets.find((st) => st.id === tweetId);

	if (!slotTweet) {
		throw new ORPCError("NOT_FOUND", {
			message: "Tweet not found in slot",
			status: 404,
		});
	}

	const currentTweetIds = slot.scheduledSlotTweets.map((st) => st.tweet.id);
	const availableTweets = await getAvailableTweets(userId, currentTweetIds);

	if (availableTweets.length === 0) {
		throw new ORPCError("BAD_REQUEST", {
			message: "No available tweets for shuffling",
			status: 400,
		});
	}
	const newTweet = pickRandom(availableTweets);

	await prisma.$transaction(async (tx) => {
		await tx.scheduledSlotPhoto.deleteMany({
			where: { scheduledSlotTweetId: tweetId },
		});
		await tx.scheduledSlotTweet.update({
			where: { id: tweetId },
			data: { tweetId: newTweet.id },
		});
		await tx.scheduledSlotPhoto.createMany({
			data: newTweet.photos.map((photo) => ({
				scheduledSlotTweetId: tweetId,
				photoId: photo.id,
				userId,
			})),
		});
	});
	return prisma.scheduledSlot.findUnique({
		where: { id: slotId },
		include: {
			scheduledSlotTweets: {
				include: {
					tweet: true,
					scheduledSlotPhotos: { include: { photo: true } },
				},
			},
		},
	});
}

async function addRandomTweetToSlot({
	slotId,
	userId,
}: {
	slotId: string;
	userId: string;
}) {
	const slot = await getSlotWithTweets(slotId, userId);

	const currentTweetIds = slot.scheduledSlotTweets.map((st) => st.tweet.id);
	const availableTweets = await getAvailableTweets(userId, currentTweetIds);

	if (availableTweets.length === 0) {
		throw new ORPCError("BAD_REQUEST", {
			message: "No available tweets to add",
			status: 400,
		});
	}
	const newTweet = pickRandom(availableTweets);

	await prisma.$transaction(async (tx) => {
		const scheduledSlotTweet = await tx.scheduledSlotTweet.create({
			data: {
				scheduledSlotId: slotId,
				tweetId: newTweet.id,
				userId,
			},
		});
		await tx.scheduledSlotPhoto.createMany({
			data: newTweet.photos.map((photo) => ({
				scheduledSlotTweetId: scheduledSlotTweet.id,
				photoId: photo.id,
				userId,
			})),
		});
	});

	return prisma.scheduledSlot.findUnique({
		where: { id: slotId },
		include: {
			scheduledSlotTweets: {
				include: {
					tweet: true,
					scheduledSlotPhotos: { include: { photo: true } },
				},
			},
		},
	});
}

const shuffleTweetSchema = z.object({
	slotId: z.uuid(),
	tweetId: z.uuid(),
});

export const shuffleTweet = protectedProcedure
	.input(shuffleTweetSchema)
	.handler(async ({ input, context }) => {
		const { slotId, tweetId } = input;
		const userId = context.databaseUserId;
		return await shuffleSlotTweet({ slotId, tweetId, userId });
	});

export const addTweetToSlot = protectedProcedure
	.input(addTweetSchema)
	.handler(async ({ input, context }) => {
		const { slotId } = input;
		const userId = context.databaseUserId;
		return await addRandomTweetToSlot({ slotId, userId });
	});

import { FlowProducer, QueueEvents, Worker } from "bullmq";
import { InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import type { RateLimiterRes } from "rate-limiter-flexible";
import { bot } from "@/bot";
import { logger } from "@/logger";
import { rateLimiter } from "@/queue/publishing";
import { prisma, redis } from "@/storage";

export const schedulerFlow = new FlowProducer({ connection: redis });

interface ScheduledTweetJobData {
	userId: string;
	slotId: string;
	tweetId: string;
}

interface ScheduledSlotJobData {
	userId: string;
	slotId: string;
	status: "PUBLISHING" | "PUBLISHED";
}

export const scheduledSlotWorker = new Worker<ScheduledSlotJobData>(
	"scheduled-slots",
	async (job) => {
		const { userId, slotId, status } = job.data;

		logger.debug({ userId, slotId }, "Processing scheduled slot");

		const slot = await prisma.scheduledSlot.findUnique({
			where: {
				id: slotId,
				userId,
			},
			include: {
				scheduledSlotTweets: true,
			},
		});

		if (!slot) {
			logger.warn(
				{ userId, slotId },
				"Scheduled slot %s not found for user %s",
				slotId,
				userId,
			);
			return;
		}

		await prisma.scheduledSlot.update({
			where: { id: slotId },
			data: {
				status,
			},
		});

		logger.info(
			{ userId, slotId },
			"Scheduled slot %s marked as %s",
			slotId,
			status,
		);
	},
	{
		connection: redis,
		concurrency: 10,
		autorun: false,
	},
);

export const scheduledTweetWorker = new Worker<ScheduledTweetJobData>(
	"scheduled-tweet",
	async (job) => {
		const { userId, slotId, tweetId } = job.data;

		logger.info(
			{ userId, slotId, tweetId },
			"Processing scheduled tweet %s for user %s in slot %s",
			tweetId,
			userId,
		);

		const scheduledTweet = await prisma.scheduledSlotTweet.findUnique({
			where: { id: tweetId, userId, scheduledSlotId: slotId },
			include: {
				scheduledSlotPhotos: {
					include: {
						photo: true,
					},
				},
				scheduledSlot: true,
			},
		});

		if (!scheduledTweet) {
			logger.warn(
				{ userId, tweetId },
				"Scheduled tweet %s not found for user %s",
				tweetId,
				userId,
			);
			return;
		}

		try {
			await rateLimiter.consume(
				scheduledTweet.scheduledSlot.chatId.toString(),
				scheduledTweet.scheduledSlotPhotos.length,
			);
		} catch (error) {
			logger.warn(
				{ userId, tweetId },
				"Rate limit exceeded for scheduled tweet %s",
				tweetId,
			);

			const delay = (error as RateLimiterRes).msBeforeNext + 1000;

			logger.warn(
				{ userId, tweetId },
				"Rate limit exceeded for scheduled tweet %s, rescheduling after %sms",
				tweetId,
				delay,
			);

			return await job.moveToDelayed(Date.now() + delay);
		}

		let messages: Message.PhotoMessage[] = [];

		if (scheduledTweet.scheduledSlotPhotos.length === 1) {
			const photo = scheduledTweet.scheduledSlotPhotos[0]?.photo;

			if (!photo) {
				logger.warn(
					{ userId, tweetId },
					"Photo not found for scheduled tweet %s",
					tweetId,
				);
				return;
			}

			messages = [
				await bot.api.sendPhoto(
					scheduledTweet.scheduledSlot.chatId.toString(),
					photo.s3Url as string,
					{
						caption: `https://x.com/i/status/${scheduledTweet.tweetId}`,
					},
				),
			];
		} else {
			const photoUrls = scheduledTweet.scheduledSlotPhotos.map(
				(scheduledPhoto, index) =>
					InputMediaBuilder.photo(scheduledPhoto.photo.s3Url as string, {
						...(index === 0 && {
							caption: `https://x.com/i/status/${scheduledTweet.tweetId}`,
						}),
					}),
			);

			messages = (await bot.api.sendMediaGroup(
				scheduledTweet.scheduledSlot.chatId.toString(),
				photoUrls,
			)) as Message.PhotoMessage[];
		}

		await prisma.publishedPhoto.createMany({
			data: scheduledTweet.scheduledSlotPhotos.map((scheduledPhoto, index) => ({
				photoId: scheduledPhoto.photoId,
				userId,
				chatId: scheduledTweet.scheduledSlot.chatId,
				mediaGroupId: messages[index]?.media_group_id,
				messageId: messages[index]?.message_id as number,
				telegramFileId: messages[index]?.photo?.[0]?.file_id as string,
				telegramFileUniqueId: messages[index]?.photo?.[0]
					?.file_unique_id as string,
				scheduledSlotId: scheduledTweet.scheduledSlotId,
			})),
		});

		logger.info(
			{ userId, slotId, tweetId },
			"Scheduled tweet %s for user %s in slot %s published",
			tweetId,
			userId,
			slotId,
		);
	},
	{
		connection: redis,
		concurrency: 1,
		lockDuration: 1000 * 60 * 5, // 5 minutes
		autorun: false,
	},
);

scheduledTweetWorker.on("failed", async (job, _err) => {
	logger.error(
		{
			jobId: job?.id,
			userId: job?.data?.userId,
			slotId: job?.data?.slotId,
			tweetId: job?.data?.tweetId,
		},
		"Scheduled tweet %s failed for user %s",
		job?.data?.tweetId,
		job?.data?.userId,
	);
});

const scheduledTweetEvents = new QueueEvents("scheduled-tweet", {
	connection: redis,
});

scheduledTweetEvents.on("completed", ({ jobId }) => {
	logger.debug({ jobId }, "Scheduled tweet completed");
});

scheduledTweetEvents.on("failed", ({ jobId, failedReason }) => {
	logger.error({ jobId, failedReason }, "Scheduled tweet failed");
});

scheduledTweetEvents.on("added", ({ jobId }) => {
	logger.debug({ jobId }, "Scheduled tweet added");
});

import { bot } from "@/bot";
import { logger } from "@/logger";
import { prisma, redis } from "@/storage";
import { Queue, QueueEvents, Worker } from "bullmq";
import { GrammyError, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import { RateLimiterRedis, type RateLimiterRes } from "rate-limiter-flexible";

interface PublishingJobData {
	chatId: number;
	userId: string;
	photoIds: string[];
	topicId?: number;
}

// Single publishing queue for all chats
export const publishingQueue = new Queue<PublishingJobData>("publishing", {
	connection: redis,
	defaultJobOptions: {
		removeOnComplete: 100,
		removeOnFail: 50,
	},
});

// Rate limiter: 10 photos per minute per chat
const rateLimiter = new RateLimiterRedis({
	storeClient: redis,
	points: 10, // 10 photos
	duration: 60, // per 60 seconds
	keyPrefix: "chat-publishing",
	blockDuration: 60, // block for 60 seconds when limit exceeded
});

// Single worker that handles all chats with intelligent routing
export const publishingWorker = new Worker<PublishingJobData>(
	"publishing",
	async (job) => {
		const { chatId, userId, photoIds } = job.data;

		// Pre-check rate limit availability
		try {
			await rateLimiter.consume(chatId, photoIds.length);
		} catch (rateLimiterRes: unknown) {
			// Rate limit exceeded - reschedule job with appropriate delay
			if (rateLimiterRes instanceof Error) {
				throw rateLimiterRes;
			}

			const msBeforeNext =
				(rateLimiterRes as RateLimiterRes).msBeforeNext || 60000; // 60 seconds
			const delay = Math.max(msBeforeNext, 1000); // At least 1s delay

			logger.debug(
				{
					chatId,
					userId,
					photoCount: photoIds.length,
					delay,
				},
				"Rate limit exceeded for chat %s, rescheduling after %sms",
				chatId,
				delay,
			);

			return await job.moveToDelayed(delay);
		}

		const photos = await prisma.photo.findMany({
			where: {
				id: { in: photoIds },
				userId,
				s3Path: {
					not: null,
				},
			},
		});

		logger.info(
			{
				chatId,
				userId,
				photoCount: photos.length,
			},
			"Processing publishing job for chat %s from user %s with %s photos",
			chatId,
			userId,
			photos.length,
		);

		const photoUrls = photos.map((photo) =>
			InputMediaBuilder.photo(photo.s3Url as string),
		);

		let messages: Message.PhotoMessage[] | undefined;

		try {
			messages = (await bot.api.sendMediaGroup(chatId, photoUrls, {
				message_thread_id: job.data.topicId,
			})) as Message.PhotoMessage[];
		} catch (error) {
			if (error instanceof GrammyError && error.error_code === 429) {
				// We stil get this error somehow, but let's reschedule the job one more time
				logger.error({ error }, "Rate limit exceeded, rescheduling job");
				return await job.moveToDelayed(
					(error.parameters.retry_after ?? 15) * 1000, // Default to 15 seconds
				);
			}

			// Don't continue if we can't somehow send a message - chat deleted, bot is blocked, etc.
			throw error;
		}

		await prisma.publishedPhoto.createMany({
			data: photos.map((photo, index) => ({
				photoId: photo.id,
				userId,
				chatId,
				mediaGroupId: messages[index]?.media_group_id,
				messageId: messages[index]?.message_id as number,
				telegramFileId: messages[index]?.photo?.at(-1)?.file_id as string,
				telegramFileUniqueId: messages[index]?.photo?.at(-1)
					?.file_unique_id as string,
			})),
			skipDuplicates: true,
		});

		logger.info(
			{
				chatId,
				userId,
			},
			"Successfully published %s photos to chat %s",
			photos.length,
			chatId,
		);
	},
	{
		connection: redis,
		concurrency: 1,
		lockDuration: 1000 * 60 * 5, // 5 minutes
	},
);

publishingWorker.on("failed", async (job, err) => {
	logger.error(
		{
			jobId: job?.id,
			chatId: job?.data?.chatId,
			userId: job?.data?.userId,
			error: err.message,
			stack: err.stack,
			attemptsMade: job?.attemptsMade,
			attemptsTotal: job?.opts?.attempts,
		},
		"Publishing job failed for chat %s",
		job?.data?.chatId,
	);
});

publishingWorker.on("completed", (job) => {
	logger.debug(
		{
			jobId: job.id,
			chatId: job.data.chatId,
			userId: job.data.userId,
			photoCount: job.data.photoIds.length,
		},
		"Publishing job completed for chat %s",
		job.data.chatId,
	);
});

const publishingEvents = new QueueEvents("publishing", {
	connection: redis,
});

publishingEvents.on("completed", ({ jobId }) => {
	logger.debug({ jobId }, "Publishing job completed");
});

publishingEvents.on("failed", ({ jobId, failedReason }) => {
	logger.error({ jobId, failedReason }, "Publishing job failed");
});

publishingEvents.on("added", ({ jobId }) => {
	logger.debug({ jobId }, "Publishing job added");
});

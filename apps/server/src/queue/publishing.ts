import { bot } from "@/bot";
import { logger } from "@/logger";
import { prisma, redis } from "@/storage";
import { FlowProducer, Queue, QueueEvents, Worker } from "bullmq";
import { GrammyError, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import { RateLimiterRedis, type RateLimiterRes } from "rate-limiter-flexible";

interface PublishingJobData {
	chatId: number;
	userId: string;
	photoIds: string[];
	topicId?: number;
	flowId?: string;
	groupIndex?: number;
	totalGroups?: number;
}

interface FlowJobId {
	id: string;
	queueName: string;
}

// Single publishing queue for all chats
export const publishingQueue = new Queue<PublishingJobData>("publishing", {
	connection: redis,
	defaultJobOptions: {
		removeOnComplete: 100,
		removeOnFail: 50,
	},
});

// Flow producer for managing sequential publishing flows
export const publishingFlowProducer = new FlowProducer({
	connection: redis,
});

// Create a publishing flow with sequential job execution
export async function createPublishingFlow(
	chatId: number,
	userId: string,
	photoGroups: Array<{ photoIds: string[] }>,
	topicId?: number,
): Promise<FlowJobId> {
	const flowId = `publish-${chatId}-${userId}-${Date.now()}`;

	// Create sequential flow by nesting children
	let currentFlow: any = null;

	// Build flow from last job to first (reverse order for proper nesting)
	for (let i = photoGroups.length - 1; i >= 0; i--) {
		const photoGroup = photoGroups[i];
		if (!photoGroup) continue;
		const jobName = `publish-group-${i}`;

		currentFlow = {
			name: jobName,
			data: {
				chatId,
				userId,
				photoIds: photoGroup.photoIds,
				topicId,
				flowId,
				groupIndex: i,
				totalGroups: photoGroups.length, // Store total groups for cancellation reporting
			},
			queueName: "publishing",
			opts: {
				delay: i * 60000, // 1 minute delay between groups for rate limiting
				removeOnComplete: 50,
				removeOnFail: 20,
				removeDependencyOnFailure: true, // Graceful failure handling
			},
			children: currentFlow ? [currentFlow] : undefined,
		};
	}

	if (currentFlow) {
		const flow = await publishingFlowProducer.add(currentFlow);

		logger.info(
			{
				flowId,
				chatId,
				userId,
				totalGroups: photoGroups.length,
				rootJobId: flow.job.id,
			},
			"Created publishing flow %s with %s groups for chat %s (root job: %s)",
			flowId,
			photoGroups.length,
			chatId,
			flow.job.id,
		);

		return {
			id: flow.job.id as string,
			queueName: "publishing",
		};
	}

	throw new Error("No photo groups provided for flow");
}

interface CancellationResult {
	success: boolean;
	groupsCancelled: number;
}

// Helper function to count total jobs in a flow tree
function countJobsInFlow(flowTree: any): number {
	let count = 1; // Count the current job
	
	if (flowTree.children && Array.isArray(flowTree.children)) {
		for (const child of flowTree.children) {
			count += countJobsInFlow(child);
		}
	}
	
	return count;
}

// Cancel a publishing flow using BullMQ hierarchical removal
export async function cancelPublishingFlow(
	flowJobId: FlowJobId,
): Promise<CancellationResult> {
	try {
		// Get the flow tree to understand its structure
		const flowTree = await publishingFlowProducer.getFlow(flowJobId);

		if (!flowTree) {
			logger.warn(
				{ flowJobId },
				"Flow not found for job %s in queue %s",
				flowJobId.id,
				flowJobId.queueName,
			);
			return { success: false, groupsCancelled: 0 };
		}

		// Get the total number of groups from the job data (not just remaining jobs)
		const totalGroups = flowTree.job.data?.totalGroups || countJobsInFlow(flowTree);

		// Remove the root job - this will automatically remove all children
		await flowTree.job.remove();

		logger.info(
			{
				rootJobId: flowJobId.id,
				queueName: flowJobId.queueName,
				chatId: flowTree.job.data?.chatId,
				userId: flowTree.job.data?.userId,
				groupsCancelled: totalGroups,
			},
			"Cancelled publishing flow with root job %s (%s groups)",
			flowJobId.id,
			totalGroups,
		);

		return { success: true, groupsCancelled: totalGroups };
	} catch (error) {
		logger.error(
			{ flowJobId, error },
			"Failed to cancel publishing flow with root job %s: %s",
			flowJobId.id,
			error instanceof Error ? error.message : String(error),
		);
		return { success: false, groupsCancelled: 0 };
	}
}

// Get active flows for a chat using BullMQ methods
export async function getActiveFlowsForChat(
	chatId: number,
): Promise<FlowJobId[]> {
	try {
		// Get all jobs from the publishing queue that might be flow jobs
		const jobs = await publishingQueue.getJobs(
			["waiting", "delayed", "waiting-children"],
			0,
			-1,
		);

		const activeFlows: FlowJobId[] = [];
		const seenFlowIds = new Set<string>();

		for (const job of jobs) {
			// Check if this job belongs to the specified chat and has a flowId
			if (job.data.chatId === chatId && job.data.flowId) {
				// Skip if we've already found a job for this flowId
				if (seenFlowIds.has(job.data.flowId)) {
					continue;
				}

				try {
					// Try to get the flow to see if this is a root job
					const flowTree = await publishingFlowProducer.getFlow({
						id: job.id as string,
						queueName: "publishing",
					});

					// If we can get the flow tree, this is a root job
					if (flowTree) {
						activeFlows.push({
							id: job.id as string,
							queueName: "publishing",
						});
						seenFlowIds.add(job.data.flowId);
					}
				} catch (error) {
					// Not a root job or flow doesn't exist, skip
					continue;
				}
			}
		}

		logger.debug(
			{ chatId, totalJobs: jobs.length, activeFlows: activeFlows.length },
			"Found %s active flows for chat %s out of %s total jobs",
			activeFlows.length,
			chatId,
			jobs.length,
		);

		return activeFlows;
	} catch (error) {
		logger.error(
			{ chatId, error },
			"Failed to get active flows for chat %s",
			chatId,
		);
		return [];
	}
}

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
		const { chatId, userId, photoIds, flowId, groupIndex } = job.data;

		// BullMQ flows handle cancellation automatically through hierarchical removal
		// No need to manually check for cancelled flows

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

			return await job.moveToDelayed(Date.now() + delay);
		}

		const photos = await prisma.photo.findMany({
			where: {
				id: { in: photoIds },
				userId,
				s3Path: {
					not: null,
				},
			},
			orderBy: [
				{
					tweetId: "desc",
				},
				{
					id: "asc",
				},
			],
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

		// BullMQ flows handle completion automatically
		// The flow completes when all children are finished

		logger.info(
			{
				chatId,
				userId,
				flowId,
				groupIndex,
			},
			"Successfully published %s photos to chat %s (flow: %s, group: %s)",
			photos.length,
			chatId,
			flowId || "none",
			groupIndex !== undefined ? groupIndex : "none",
		);
	},
	{
		connection: redis,
		concurrency: 1,
		lockDuration: 1000 * 60 * 5, // 5 minutes
		autorun: false,
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

import { prisma, redis } from "@/storage";
import { Queue, Worker } from "bullmq";

export const scrapperQueue = new Queue<ScrapperJobData>("feed-scrapper", {
	connection: redis,
	defaultJobOptions: {
		attempts: 3,
		// It will be retried in 5 minutes, 15 minutes, 70 minutes
		backoff: {
			type: "exponential",
			delay: 300000, // 5 minutes
		},
	},
});

interface ScrapperJobData {
	userId: string;
}

export const scrapperWorker = new Worker<ScrapperJobData>(
	"feed-scrapper",
	async (job) => {
		const { userId } = job.data;

		const user = await prisma.user.findUnique({
			where: { id: userId },
		});
	},
	{
		connection: redis,
		concurrency: 1,
		autorun: false,
		removeOnComplete: { age: 60 * 60 * 24, count: 100 },
		removeOnFail: { age: 60 * 60 * 24 * 7, count: 50 },
	},
);

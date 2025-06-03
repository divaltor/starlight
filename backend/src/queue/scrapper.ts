import { redis } from "@/storage";
import { Queue } from "bullmq";

const scrapperQueue = new Queue("feed-scrapper", {
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

export { scrapperQueue };
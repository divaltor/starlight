import { env } from "@starlight/utils";
import Redis from "ioredis";

export const redis = new Redis(env.REDIS_URL, {
	enableReadyCheck: true,
	maxRetriesPerRequest: 1,
	reconnectOnError: () => 2,
});

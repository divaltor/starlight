import { RedisClient } from "bun";
import { env } from "@starlight/utils";
import { createBunRedisClient } from "bullmq";

export const redis = createBunRedisClient(new RedisClient(env.REDIS_URL));

export const s3 = new Bun.S3Client({
	accessKeyId: env.AWS_ACCESS_KEY_ID,
	secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	endpoint: env.AWS_ENDPOINT,
});

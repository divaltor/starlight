import { env } from "@starlight/utils";

export const redis = new Bun.RedisClient(env.REDIS_URL);

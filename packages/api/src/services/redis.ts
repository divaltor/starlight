import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

const env = createEnv({
  server: {
    REDIS_URL: z.url({ protocol: /^rediss?$/u }),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: false,
});

export const redis = new Bun.RedisClient(env.REDIS_URL);

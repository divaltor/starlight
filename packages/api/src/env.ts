import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

const env = createEnv({
  server: {
    COOKIE_ENCRYPTION_KEY: z.string().min(64),
    COOKIE_ENCRYPTION_SALT: z.string().min(16),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: false,
});

export default env;

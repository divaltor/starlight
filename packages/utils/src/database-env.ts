import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

const databaseEnv = createEnv({
  server: {
    BASE_CDN_URL: z
      .string()
      .transform((value) => {
        if (value) return value;
        if (!process.env.BASE_FRONTEND_URL) return "";

        try {
          const url = new URL(
            process.env.BASE_FRONTEND_URL.startsWith("http")
              ? process.env.BASE_FRONTEND_URL
              : `https://${process.env.BASE_FRONTEND_URL}`,
          );
          url.hostname = `cdn.${url.hostname}`;
          return url.toString();
        } catch {
          return process.env.BASE_FRONTEND_URL;
        }
      })
      .default(""),

    DATABASE_URL: z.url({ protocol: /^postgresql$/u }),

    NODE_ENV: z.enum(["development", "production"]).default("development"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: false,
});

export default databaseEnv;

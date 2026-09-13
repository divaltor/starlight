import { createContext } from "@starlight/api/context";
import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { ManagedRuntime } from "effect";
import env from "@/env.server";

const runtime = ManagedRuntime.make(
  EmbeddingsService.defaultLayer({
    apiToken: env.ML_API_TOKEN,
    baseUrl: env.ML_BASE_URL,
  }),
);

export const corsOrigin = env.CORS_ORIGIN;

export function createApiContext(request: Request) {
  return createContext({
    request,
    config: {
      baseCdnUrl: env.BASE_CDN_URL,
      botToken: env.BOT_TOKEN,
      cookieEncryptionKey: env.COOKIE_ENCRYPTION_KEY,
      cookieEncryptionSalt: env.COOKIE_ENCRYPTION_SALT,
      embeddingsEnabled: !!(env.ML_BASE_URL && env.ML_API_TOKEN),
      nodeEnv: env.NODE_ENV,
    },
    generateTextEmbedding: (query, requestId) =>
      runtime.runPromise(EmbeddingsService.Service.use((service) => service.generateText(query, requestId))),
  });
}

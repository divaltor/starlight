export interface CreateContextOptions {
  readonly config: {
    readonly baseCdnUrl: string;
    readonly botToken: string;
    readonly cookieEncryptionKey: string;
    readonly cookieEncryptionSalt: string;
    readonly embeddingsEnabled: boolean;
    readonly nodeEnv: "development" | "production";
  };
  readonly generateTextEmbedding: (query: string, requestId: string) => Promise<number[] | null>;
  readonly request: Request;
}

export function createContext(options: CreateContextOptions) {
  const requestId = options.request.headers.get("X-Request-Id") || Bun.randomUUIDv7();

  return {
    config: options.config,
    generateTextEmbedding: options.generateTextEmbedding,
    request: options.request,
    requestId,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

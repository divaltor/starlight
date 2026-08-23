export interface CreateContextOptions {
  request: Request;
}

export function createContext({ request }: CreateContextOptions) {
  const requestId = request.headers.get("X-Request-Id") || Bun.randomUUIDv7();

  return {
    request,
    requestId,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

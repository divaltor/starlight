import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
	context: HonoContext;
};

// biome-ignore lint/suspicious/useAwait: We don't need to await this function
export async function createContext({ context }: CreateContextOptions) {
	const requestId = context.req.header("X-Request-Id") || Bun.randomUUIDv7();
	return {
		request: context.req,
		requestId,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;

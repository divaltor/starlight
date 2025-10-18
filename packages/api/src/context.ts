import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
	context: HonoContext;
};

// biome-ignore lint/suspicious/useAwait: We don't need to await this function
export async function createContext({ context }: CreateContextOptions) {
	return {
		request: context.req,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;

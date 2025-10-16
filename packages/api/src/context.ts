import type { Context as ElysiaContext } from "elysia";

export type CreateContextOptions = {
	context: ElysiaContext;
};

// biome-ignore lint/suspicious/useAwait: We don't need to await this function
export async function createContext({ context }: CreateContextOptions) {
	return {
		request: context,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;

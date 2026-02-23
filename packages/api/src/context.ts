export interface CreateContextOptions {
	request: Request;
}

// biome-ignore lint/suspicious/useAwait: We don't need to await this function
export async function createContext({ request }: CreateContextOptions) {
	const requestId = request.headers.get("X-Request-Id") || Bun.randomUUIDv7();

	return {
		request,
		requestId,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;

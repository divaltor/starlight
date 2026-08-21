import { redis } from "./redis";

const EMBEDDING_CACHE_TTL_SECONDS = 30 * 24 * 3600;

// Shared by the mini app search router and the bot inline search handler; both
// must go through this helper so they hit the same cache keys.
export async function resolveQueryEmbedding(
	generate: () => Promise<number[] | null>,
	query: string,
): Promise<number[] | null> {
	const cacheKey = `embedding:${Bun.hash.xxHash3(query).toString(16)}`;

	const cached = await redis.get(cacheKey);

	if (cached) {
		return JSON.parse(cached) as number[];
	}

	const result = await generate();

	if (!result) {
		return null;
	}

	await redis.set(cacheKey, JSON.stringify(result), "EX", EMBEDDING_CACHE_TTL_SECONDS);

	return result;
}

import { ORPCError } from "@orpc/client";
import { env } from "@starlight/utils";
import { z } from "zod";
import { publicProcedure } from "..";
import { Cursor, type CursorPayload } from "../utils/cursor";

const SearchQuery = z.object({
	query: z.string().min(1),
	cursor: z.string().optional(),
	limit: z.number().min(1).max(100).default(30),
});

type EmbeddingResponse = {
	text: number[];
};

export const searchImages = publicProcedure
	.input(SearchQuery)
	.handler(async ({ input }) => {
		const { query, cursor } = input;

		if (!(env.ML_BASE_URL && env.ML_API_TOKEN)) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Search service is not available",
				status: 503,
			});
		}

		let queryVector: number[];

		try {
			const response = await fetch(
				new URL("/v1/embeddings", env.ML_BASE_URL).toString(),
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-API-Token": env.ML_API_TOKEN,
					},
					body: JSON.stringify({
						tags: [query],
					}),
				}
			);

			if (!response.ok) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to find images",
					status: 500,
				});
			}

			const data = (await response.json()) as EmbeddingResponse;

			queryVector = data.text;
		} catch {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to generate search embeddings",
				status: 500,
			});
		}

		let cursorData: CursorPayload | null = null;
		if (cursor) {
			cursorData = Cursor.parse(cursor);

			if (!cursorData) {
				return {
					photos: [],
					nextCursor: null,
				};
			}
		}

		const vectorStr = `[${queryVector.join(",")}]`;

		return {
			photos: transformedPhotos,
			nextCursor,
		};
	});

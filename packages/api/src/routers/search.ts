import { ORPCError } from "@orpc/client";
import { env, prisma } from "@starlight/utils";
import z from "zod";
import { publicProcedure } from "..";
import type { SearchResult } from "../types/tweets";
import { transformSearchResults } from "../utils/transformations";

interface FusionItem extends SearchResult {
	s_image: number;
	s_tag: number;
	aesthetic: number;
	style_anime: number;
	style_manga: number;
	style_other: number;
	style_real_life: number;
	style_third_dimension: number;
}

const computeFinalScore = (item: FusionItem): number => {
	const {
		s_image,
		s_tag,
		aesthetic,
		style_anime,
		style_manga,
		style_other,
		style_real_life,
		style_third_dimension,
	} = item;
	return (
		0.5 * Math.max(s_image, s_tag) +
		0.3 * s_image +
		0.2 * s_tag +
		0.1 * aesthetic +
		0.03 * style_anime +
		0.03 * style_manga -
		0.07 * style_other -
		0.1 * style_real_life -
		0.1 * style_third_dimension
	);
};

export const searchImages = publicProcedure
	.input(
		z.object({
			query: z.string().max(128),
		})
	)
	.handler(async ({ input }) => {
		if (!(env.ML_BASE_URL && env.ML_API_TOKEN)) {
			throw new ORPCError("Service not available, sorry!");
		}

		const response = await fetch(
			new URL("/v1/embeddings", env.ML_BASE_URL).toString(),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-API-Token": env.ML_API_TOKEN,
				},
				body: JSON.stringify({
					text: input.query,
					encoding_mode: "retrieval.query",
				}),
			}
		);

		if (!response.ok) {
			throw new ORPCError("Failed to search images", {
				status: 500,
			});
		}

		const { text } = (await response.json()) as { text: string[] };

		const textVec = `[${text.join(",")}]`;

		const imageResultsPromise = prisma.$queryRaw<FusionItem[]>`
			WITH similarities AS (
				SELECT
					p.id,
					1.0 - (p.image_vec <=> ${textVec}::vector) AS s_image,
					1.0 - (p.tag_vec <=> ${textVec}::vector) AS s_tag,
					p.s3_path,
					p.original_url,
					t.username,
					t.created_at as tweet_created_at,
					t.id as tweet_id,
					(p.classification->>'aesthetic')::float AS aesthetic,
					(p.classification->'style'->>'anime')::float AS style_anime,
					(p.classification->'style'->>'manga_like')::float AS style_manga,
					(p.classification->'style'->>'other')::float AS style_other,
					(p.classification->'style'->>'real_life')::float AS style_real_life,
					(p.classification->'style'->>'third_dimension')::float AS style_third_dimension,
					(p.classification->'nsfw'->>'is_nsfw')::boolean AS is_nsfw
				FROM photos p
				JOIN tweets t ON t.id = p.tweet_id
				WHERE p.image_vec IS NOT NULL AND p.tag_vec IS NOT NULL AND p.user_id IN (SELECT id FROM users WHERE is_public = true)
			)
			SELECT
				id as photo_id,
				original_url,
				s3_path,
				username,
				tweet_created_at,
				tweet_id,
				is_nsfw,
				s_image,
				s_tag,
				aesthetic,
				style_anime,
				style_manga,
				style_other,
				style_real_life,
				style_third_dimension
			FROM similarities
			ORDER BY s_image DESC
			LIMIT 100
		`;

		const tagResultsPromise = prisma.$queryRaw<FusionItem[]>`
			WITH similarities AS (
				SELECT
					p.id,
					1.0 - (p.image_vec <=> ${textVec}::vector) AS s_image,
					1.0 - (p.tag_vec <=> ${textVec}::vector) AS s_tag,
					p.s3_path,
					p.original_url,
					t.username,
					t.created_at as tweet_created_at,
					t.id as tweet_id,
					(p.classification->>'aesthetic')::float AS aesthetic,
					(p.classification->'style'->>'anime')::float AS style_anime,
					(p.classification->'style'->>'manga_like')::float AS style_manga,
					(p.classification->'style'->>'other')::float AS style_other,
					(p.classification->'style'->>'real_life')::float AS style_real_life,
					(p.classification->'style'->>'third_dimension')::float AS style_third_dimension,
					(p.classification->'nsfw'->>'is_nsfw')::boolean AS is_nsfw
				FROM photos p
				JOIN tweets t ON t.id = p.tweet_id
				WHERE p.image_vec IS NOT NULL AND p.tag_vec IS NOT NULL AND p.user_id IN (SELECT id FROM users WHERE is_public = true)
			)
			SELECT
				id as photo_id,
				original_url,
				s3_path,
				username,
				tweet_created_at,
				tweet_id,
				is_nsfw,
				s_image,
				s_tag,
				aesthetic,
				style_anime,
				style_manga,
				style_other,
				style_real_life,
				style_third_dimension
			FROM similarities
			ORDER BY s_tag DESC
			LIMIT 100
		`;

		const [imageResults, tagResults] = await Promise.all([
			imageResultsPromise,
			tagResultsPromise,
		]);

		const allResults = new Map<string, FusionItem>();
		for (const res of [...imageResults, ...tagResults]) {
			allResults.set(res.photo_id, res);
		}

		const imageRanks = new Map(
			imageResults.map((r, idx) => [r.photo_id, idx + 1])
		);
		const tagRanks = new Map(tagResults.map((r, idx) => [r.photo_id, idx + 1]));

		const rrfScores = new Map<string, number>();
		const k = 60;
		for (const [id] of allResults) {
			let score = 0;
			const imgRank = imageRanks.get(id);
			if (imgRank !== undefined) {
				score += 1 / (k + imgRank);
			}
			const tagRank = tagRanks.get(id);
			if (tagRank !== undefined) {
				score += 1 / (k + tagRank);
			}
			rrfScores.set(id, score);
		}

		const topIds = Array.from(rrfScores.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 40)
			.map(([id]) => id);

		const finalImages: SearchResult[] = topIds
			.map((id) => {
				const item = allResults.get(id);

				if (!item) {
					return null;
				}

				return {
					photo_id: item.photo_id,
					original_url: item.original_url,
					s3_path: item.s3_path,
					username: item.username,
					tweet_created_at: item.tweet_created_at,
					tweet_id: item.tweet_id,
					is_nsfw: item.is_nsfw,
				} as SearchResult;
			})
			.filter((item): item is SearchResult => item !== null)
			.sort((aItem, bItem) => {
				const a = allResults.get(aItem.photo_id);
				const b = allResults.get(bItem.photo_id);
				if (!(a && b)) {
					return 0;
				}
				return computeFinalScore(b) - computeFinalScore(a);
			});

		return transformSearchResults(finalImages);
	});

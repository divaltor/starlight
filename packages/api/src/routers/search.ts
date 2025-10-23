import { ORPCError } from "@orpc/client";
import { env, prisma } from "@starlight/utils";
import z from "zod";
import { publicProcedure } from "..";
import type { SearchResult } from "../types/tweets";
import { transformSearchResults } from "../utils/transformations";

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
					tags: input.query,
					encoding_mode: "retrieval.query",
				}),
			}
		);

		if (!response.ok) {
			throw new ORPCError("Failed to search images", {
				status: 500,
			});
		}

		const { text } = (await response.json()) as { text: number[] };

		const textVec = `[${text.join(",")}]`;

		const images = await prisma.$queryRaw<SearchResult[]>`
        WITH coarse AS (
            SELECT DISTINCT
                p.id,
                1.0 - (p.image_vec <=> ${textVec}::vector) AS s_image,
                1.0 - (p.tag_vec <=> ${textVec}::vector) AS s_tag,
                GREATEST(1.0 - (p.image_vec <=> ${textVec}::vector), 1.0 - (p.tag_vec <=> ${textVec}::vector)) AS s_coarse
            FROM photos p
            WHERE classification IS NOT NULL AND image_vec IS NOT NULL AND tag_vec IS NOT NULL AND p.user_id IN (SELECT id FROM users WHERE is_public = true)
            ORDER BY s_coarse DESC
        ),
        metadata_fusion AS (
            SELECT
                p.id,
                c.s_coarse,
                c.s_image,
                c.s_tag,
                p.s3_path,
                p.original_url,
                t.username,
                t.created_at,
                t.id as tweet_id,
                t.created_at as tweet_created_at,
                (classification->>'aesthetic')::float AS aesthetic,
                (classification->'style'->>'anime')::float AS style_anime,
                (classification->'style'->>'manga_like')::float AS style_manga,
                (classification->'style'->>'other')::float AS style_other,
                (classification->'style'->>'real_life')::float AS style_real_life,
                (classification->'style'->>'third_dimension')::float AS style_third_dimension,
                (classification->'nsfw'->>'is_nsfw')::boolean AS is_nsfw
            FROM coarse c
            JOIN photos p ON p.id = c.id
            JOIN tweets t ON t.id = p.tweet_id
        ),
        ranked AS (
            SELECT
                *,
                ROW_NUMBER() OVER (ORDER BY s_image DESC) as rank_image,
                ROW_NUMBER() OVER (ORDER BY s_tag DESC) as rank_tag,
                ROW_NUMBER() OVER (ORDER BY aesthetic DESC) as rank_aesthetic,
                ROW_NUMBER() OVER (ORDER BY tweet_created_at DESC) as rank_recency
            FROM metadata_fusion
        ),
        fused AS (
            SELECT
                id as photo_id,
                original_url as original_url,
                s3_path as s3_path,
                username,
                tweet_created_at as tweet_created_at,
                tweet_id as tweet_id,
                is_nsfw as is_nsfw,
                (
                    (1.0 / (rank_image + 60) * 0.5) +
                    (1.0 / (rank_tag + 60) * 0.3) +
                    (1.0 / (rank_aesthetic + 60) * 0.1) +
                    (1.0 / (rank_recency + 60) * 0.1)
                ) * 
                (
                    (aesthetic) * EXP(LN(0.5) * (EXTRACT(EPOCH FROM (NOW() - tweet_created_at)) / (30.0 * 24 * 3600)))
                ) AS final_score
            FROM ranked
        )
        SELECT
            photo_id,
            original_url,
            s3_path,
            username,
            tweet_created_at,
            tweet_id,
            is_nsfw,
            final_score
        FROM fused
        ORDER BY final_score DESC NULLS LAST
        LIMIT 80;
		`;

		console.log(images);

		return transformSearchResults(images);
	});

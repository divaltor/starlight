import { Decoder, Encoder } from "@msgpack/msgpack";
import { ORPCError } from "@orpc/client";
import { env, Prisma, prisma } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import z from "zod";
import { publicProcedure } from "..";
import { maybeAuthProcedure } from "../middlewares/auth";
import type { SearchResult } from "../types/tweets";
import { Cursor, type SearchCursorPayload } from "../utils/cursor";
import { redis } from "../utils/redis";
import { transformSearchResults } from "../utils/transformations";

const encoder = new Encoder();
const decoder = new Decoder();

export const searchImages = maybeAuthProcedure
	.input(
		z.object({
			query: z.string().max(256),
			cursor: z.string().optional(),
			limit: z.number().min(1).max(100).default(30),
			ownOnly: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		if (!(env.ML_BASE_URL && env.ML_API_TOKEN)) {
			throw new ORPCError("Service not available, sorry!");
		}

		const { user } = context;
		const query = input.query.trim();
		const { cursor, limit, ownOnly } = input;

		// If ownOnly is true, require authentication
		if (ownOnly && !user) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Authentication required for personal search",
				status: 401,
			});
		}

		// Get database user ID if searching own tweets
		let databaseUserId: string | null = null;
		if (ownOnly && user) {
			const dbUser = await prisma.user.findUnique({
				where: { telegramId: user.id },
				select: { id: true },
			});
			if (!dbUser) {
				throw new ORPCError("NOT_FOUND", {
					message: "User not found",
					status: 404,
				});
			}
			databaseUserId = dbUser.id;
		}

		const hashedQuery = Bun.hash.xxHash3(query);
		const ttlKey = `query:${hashedQuery}`;
		let text: number[];
		let memberExists: Buffer | null = null;

		try {
			memberExists = await redis.getexBuffer(ttlKey, "EX", 60 * 60 * 24 * 90);
		} catch {
			// Redis unavailable, proceed without cache
		}

		if (memberExists) {
			text = decoder.decode(memberExists) as number[];
		} else {
			const response = await http(new URL("/v1/embeddings", env.ML_BASE_URL).toString(), {
				method: "post",
				headers: {
					"Content-Type": "application/json",
					"X-API-Token": env.ML_API_TOKEN,
					"X-Request-Id": context.requestId,
				},
				json: {
					tags: query,
					encoding_mode: "retrieval.query",
				},
			});

			if (!response.ok) {
				throw new ORPCError("Failed to search images", {
					status: 500,
				});
			}

			const data = (await response.json()) as {
				text: number[];
			};

			text = data.text;

			try {
				await redis.setex(ttlKey, 60 * 60 * 24 * 7, Buffer.from(encoder.encode(text)));
			} catch {
				// Redis unavailable, skip caching
			}
		}

		let cursorData: SearchCursorPayload | null = null;
		if (cursor) {
			cursorData = Cursor.parse<SearchCursorPayload>(cursor);

			if (!cursorData) {
				return {
					results: [],
					nextCursor: null,
				};
			}
		}

		const queryTime = cursorData?.queryTime ?? new Date().toISOString();
		const textQuery = `[${text.join(",")}]`;
		const queryLower = query.toLowerCase();
		const queryContains = `%${queryLower}%`;
		const queryStartsWith = `${queryLower}%`;
		const queryStartsWithSeries = `${queryLower} (%`;
		const candidateLimit = Math.max(limit * 8, 200);
		const hasLexicalQuery = queryLower.length > 0;

		// Build user filter based on ownOnly flag
		const userFilter =
			ownOnly && databaseUserId
				? Prisma.sql`p.user_id = ${databaseUserId}`
				: Prisma.sql`p.user_id IN (SELECT id FROM users WHERE is_public = true)`;

		const baseFilter = Prisma.sql`
			p.deleted_at IS NULL
			AND p.classification IS NOT NULL
			AND p.image_vec IS NOT NULL
			AND p.tag_vec IS NOT NULL
			AND ${userFilter}
		`;

		const lexicalMatch = hasLexicalQuery
			? Prisma.sql`
				(
					EXISTS (
						SELECT 1
						FROM jsonb_array_elements_text(COALESCE(p.classification->'characters', '[]'::jsonb)) AS character_tag(value)
						WHERE lower(character_tag.value) = ${queryLower}
							OR lower(character_tag.value) LIKE ${queryStartsWithSeries}
							OR lower(character_tag.value) LIKE ${queryStartsWith}
							OR lower(character_tag.value) LIKE ${queryContains}
					)
					OR EXISTS (
						SELECT 1
						FROM jsonb_array_elements_text(COALESCE(p.classification->'tags', '[]'::jsonb)) AS general_tag(value)
						WHERE lower(general_tag.value) = ${queryLower}
							OR lower(general_tag.value) LIKE ${queryStartsWith}
							OR lower(general_tag.value) LIKE ${queryContains}
					)
					OR lower(COALESCE(t.tweet_text, '')) LIKE ${queryContains}
					OR EXISTS (
						SELECT 1
						FROM jsonb_array_elements_text(COALESCE(t.tweet_data->'hashtags', '[]'::jsonb)) AS hashtag(value)
						WHERE lower(hashtag.value) = ${queryLower}
							OR lower(hashtag.value) LIKE ${queryStartsWith}
							OR lower(hashtag.value) LIKE ${queryContains}
					)
				)
			`
			: Prisma.sql`FALSE`;

		const paginationClause = cursorData
			? Prisma.sql`AND (final_score < ${cursorData.lastScore} OR (final_score = ${cursorData.lastScore} AND photo_id < ${cursorData.lastPhotoId}))`
			: Prisma.empty;

		const images = await prisma.$queryRaw<SearchResult[]>(Prisma.sql`
			WITH image_candidates AS (
				SELECT p.id, p.user_id
				FROM photos p
				WHERE ${baseFilter}
				ORDER BY p.image_vec <=> ${textQuery}::vector
				LIMIT ${candidateLimit}
			),
			tag_candidates AS (
				SELECT p.id, p.user_id
				FROM photos p
				WHERE ${baseFilter}
				ORDER BY p.tag_vec <=> ${textQuery}::vector
				LIMIT ${candidateLimit}
			),
			lexical_candidates AS (
				SELECT p.id, p.user_id
				FROM photos p
				JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
				WHERE ${baseFilter}
					AND ${lexicalMatch}
				LIMIT ${candidateLimit}
			),
			candidate_pool AS (
				SELECT DISTINCT id, user_id
				FROM (
					SELECT id, user_id FROM image_candidates
					UNION ALL
					SELECT id, user_id FROM tag_candidates
					UNION ALL
					SELECT id, user_id FROM lexical_candidates
				) candidates
			),
				scored AS (
					SELECT
						p.id AS photo_id,
						COALESCE(NULLIF(p.perceptual_hash, ''), p.id) AS dedupe_key,
						p.height,
						p.width,
						p.original_url,
					p.s3_path,
					t.username,
					t.created_at AS tweet_created_at,
					t.id AS tweet_id,
					COALESCE((p.classification->'nsfw'->>'is_nsfw')::boolean, false) AS is_nsfw,
					COALESCE(1.0 - (p.image_vec <=> ${textQuery}::vector), 0.0) AS s_image,
					COALESCE(1.0 - (p.tag_vec <=> ${textQuery}::vector), 0.0) AS s_tag_semantic,
					COALESCE((p.classification->>'aesthetic')::float, 0.0) AS aesthetic,
					COALESCE((p.classification->'style'->>'anime')::float, 0.0) AS style_anime,
					COALESCE((p.classification->'style'->>'real_life')::float, 0.0) AS style_real_life,
					COALESCE(
						(
							SELECT MAX(
								CASE
									WHEN lower(character_tag.value) = ${queryLower} THEN CASE WHEN character_tag.ordinality <= 2 THEN 1.0 ELSE 0.96 END
									WHEN lower(character_tag.value) LIKE ${queryStartsWithSeries} THEN CASE WHEN character_tag.ordinality <= 2 THEN 0.97 ELSE 0.92 END
									WHEN lower(character_tag.value) LIKE ${queryStartsWith} THEN CASE WHEN character_tag.ordinality <= 2 THEN 0.92 ELSE 0.86 END
									WHEN lower(character_tag.value) LIKE ${queryContains} THEN CASE WHEN character_tag.ordinality <= 2 THEN 0.82 ELSE 0.76 END
									ELSE 0.0
								END
							)
							FROM jsonb_array_elements_text(COALESCE(p.classification->'characters', '[]'::jsonb)) WITH ORDINALITY AS character_tag(value, ordinality)
						),
						0.0
					) AS s_character,
					COALESCE(
						(
							SELECT MAX(
								CASE
									WHEN lower(general_tag.value) = ${queryLower} THEN 0.88
									WHEN lower(general_tag.value) LIKE ${queryStartsWith} THEN 0.74
									WHEN lower(general_tag.value) LIKE ${queryContains} THEN 0.58
									ELSE 0.0
								END
							)
							FROM jsonb_array_elements_text(COALESCE(p.classification->'tags', '[]'::jsonb)) AS general_tag(value)
						),
						0.0
					) AS s_tag_lexical,
					COALESCE(
						(
							SELECT MAX(
								CASE
									WHEN lower(hashtag.value) = ${queryLower} THEN 0.76
									WHEN lower(hashtag.value) LIKE ${queryStartsWith} THEN 0.62
									WHEN lower(hashtag.value) LIKE ${queryContains} THEN 0.5
									ELSE 0.0
								END
							)
							FROM jsonb_array_elements_text(COALESCE(t.tweet_data->'hashtags', '[]'::jsonb)) AS hashtag(value)
						),
						0.0
					) AS s_hashtag,
					CASE WHEN lower(COALESCE(t.tweet_text, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END AS s_tweet_text
				FROM candidate_pool c
				JOIN photos p ON p.id = c.id AND p.user_id = c.user_id
				JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
			),
			fused AS (
					SELECT
						photo_id,
						dedupe_key,
						height,
						width,
						original_url,
					s3_path,
					username,
					tweet_created_at,
					tweet_id,
					is_nsfw,
					(
						(s_character * 0.44) +
						(GREATEST(s_tag_semantic, s_tag_lexical) * 0.28) +
						(GREATEST(s_hashtag, s_tweet_text) * 0.12) +
						(s_image * 0.1) +
						LEAST(0.04, GREATEST(0.0, aesthetic * (1.0 - style_real_life) * (0.65 + (style_anime * 0.35))) * 0.04) +
						(0.02 * EXP(LN(0.5) * (EXTRACT(EPOCH FROM (${queryTime}::timestamptz - tweet_created_at)) / (180.0 * 24 * 3600.0))))
					) AS final_score
				FROM scored
				),
				deduped AS (
					SELECT
						photo_id,
						height,
						width,
						original_url,
						s3_path,
						username,
						tweet_created_at,
						tweet_id,
						is_nsfw,
						final_score,
						ROW_NUMBER() OVER (
							PARTITION BY dedupe_key
							ORDER BY final_score DESC NULLS LAST, tweet_created_at DESC, photo_id DESC
						) AS duplicate_rank
					FROM fused
				)
			SELECT
				photo_id,
				height,
				width,
				original_url,
				s3_path,
				username,
				tweet_created_at,
				tweet_id,
				is_nsfw,
				final_score
			FROM deduped
			WHERE duplicate_rank = 1
			${paginationClause}
			ORDER BY final_score DESC NULLS LAST, photo_id DESC
			LIMIT ${limit}
		`);

		const transformedResults = transformSearchResults(images);

		let nextCursor: string | null = null;
		if (images.length === limit) {
			// biome-ignore lint/style/noNonNullAssertion: We know there's at least one image
			const lastImage = images.at(-1)!;
			nextCursor = Cursor.create<SearchCursorPayload>({
				lastScore: lastImage.final_score,
				lastPhotoId: lastImage.photo_id,
				queryTime,
			});
		}

		return {
			results: transformedResults,
			nextCursor,
		};
	});

export const randomImages = publicProcedure.handler(async () => {
	const images = await prisma.$queryRaw<SearchResult[]>`
        WITH base AS (
            SELECT
                p.id,
                p.height,
                p.width,
                p.s3_path,
                p.original_url,
                t.username,
                t.created_at as tweet_created_at,
                t.id as tweet_id,
                (p.classification->>'aesthetic')::float AS aesthetic,
                (p.classification->'style'->>'anime')::float AS style_anime,
                (p.classification->'style'->>'real_life')::float AS style_real_life,
                (p.classification->'style'->>'other')::float AS style_other,
                (p.classification->'nsfw'->>'is_nsfw')::boolean AS is_nsfw
			FROM photos p
			JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
			WHERE p.classification IS NOT NULL 
			AND p.deleted_at IS NULL
			AND p.user_id IN (SELECT id FROM users WHERE is_public = true)
			AND NOT (p.classification->'nsfw'->>'is_nsfw')::boolean
        ),
        ranked AS (
            SELECT *,
                aesthetic * style_anime * 
                (1.0 - style_real_life) * 
                (1.0 - style_other) AS effective,
                ROW_NUMBER() OVER (
                    ORDER BY 
                    aesthetic * style_anime * 
                    (1.0 - style_real_life) * 
                    (1.0 - style_other) DESC
                ) AS rank_style,
                ROW_NUMBER() OVER (ORDER BY tweet_created_at DESC) AS rank_recency
            FROM base
        ),
        fused AS (
            SELECT
                id as photo_id,
                height,
                width,
                s3_path,
                original_url,
                username,
                tweet_created_at,
                tweet_id,
                is_nsfw,
                (
                    (1.0 / (rank_style + 60) * 0.9) +
                    (1.0 / (rank_recency + 60) * 0.1)
                ) * effective * 
                EXP(LN(0.5) * (EXTRACT(EPOCH FROM (NOW() - tweet_created_at)) / (30.0 * 24 * 3600.0))) AS final_score
            FROM ranked
        ),
        top500 AS (
            SELECT * FROM fused 
            ORDER BY final_score DESC 
            LIMIT 500
        )
        SELECT
            photo_id,
            original_url,
            s3_path,
            username,
            height,
            width,
            tweet_created_at,
            tweet_id,
            is_nsfw,
            final_score
        FROM top500
        ORDER BY RANDOM()
        LIMIT 30;
	`;

	return transformSearchResults(images);
});

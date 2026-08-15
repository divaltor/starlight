import { ORPCError } from "@orpc/client";
import { env, Prisma, prisma } from "@starlight/utils";
import z from "zod";
import { publicProcedure } from "..";
import { maybeAuthProcedure } from "../middlewares/auth";
import { EmbeddingsService } from "../services/embeddings";
import { runtime } from "../services/runtime";
import type { SearchResult } from "../types/posts";
import { Cursor, SearchCursorPayloadSchema, type SearchCursorPayload } from "../utils/cursor";
import { paginateSearchResults } from "../utils/search-pagination";
import { transformSearchResults } from "../utils/transformations";

const galleryDedupePartitionSql = "user_id, dedupe_key";
const galleryRepresentativeOrderSql =
	"final_score DESC NULLS LAST, provider DESC, media_id DESC, user_id DESC, post_created_at DESC, post_id DESC";

const galleryDedupeKeySql = (mediaAlias: string) =>
	`COALESCE(NULLIF(${mediaAlias}.perceptual_hash, ''), jsonb_build_array(${mediaAlias}.provider, ${mediaAlias}.external_id, ${mediaAlias}.user_id)::text)`;

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

		// Get database user ID if searching the authenticated user's posts
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

		const hashedQuery = BigInt.asIntN(64, BigInt(Bun.hash.xxHash3(query)));
		let text: number[];

		const [cached] = await prisma.$queryRaw<Array<{ embedding: string }>>(
			Prisma.sql`SELECT embedding FROM embedding_cache WHERE query = ${hashedQuery}`,
		);

		if (cached) {
			text = JSON.parse(cached.embedding) as number[];
		} else {
			const result = await runtime.runPromise(
				EmbeddingsService.Service.use((s) => s.generateText(query, context.requestId)),
			);

			if (!result) {
				throw new ORPCError("Failed to search images", {
					status: 500,
				});
			}

			text = result;

			const vecStr = `[${text.join(",")}]`;
			await prisma.$executeRaw(
				Prisma.sql`INSERT INTO embedding_cache (query, embedding, updated_at) VALUES (${hashedQuery}, ${vecStr}::vector, NOW()) ON CONFLICT (query) DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = NOW()`,
			);
		}

		let cursorData: SearchCursorPayload | null = null;
		if (cursor) {
			cursorData = Cursor.parse(cursor, SearchCursorPayloadSchema);

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
			AND p.s3_path IS NOT NULL
			AND p.kind = 'image'
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
					OR lower(COALESCE(t.text, '')) LIKE ${queryContains}
					OR lower(COALESCE(t.title, '')) LIKE ${queryContains}
					OR lower(COALESCE(t.author_name, '')) LIKE ${queryContains}
					OR lower(COALESCE(t.author_username, '')) LIKE ${queryContains}
					OR EXISTS (
						SELECT 1
						FROM unnest(t.tags) AS post_tag(value)
						WHERE lower(post_tag.value) = ${queryLower}
							OR lower(post_tag.value) LIKE ${queryStartsWith}
							OR lower(post_tag.value) LIKE ${queryContains}
					)
				)
			`
			: Prisma.sql`FALSE`;

		const paginationClause = cursorData
			? Prisma.sql`WHERE (
				final_score < ${cursorData.lastScore}
				OR (final_score = ${cursorData.lastScore} AND post_provider < ${cursorData.lastProvider})
				OR (final_score = ${cursorData.lastScore} AND post_provider = ${cursorData.lastProvider} AND post_id < ${cursorData.lastPostId})
				OR (final_score = ${cursorData.lastScore} AND post_provider = ${cursorData.lastProvider} AND post_id = ${cursorData.lastPostId} AND user_id < ${cursorData.lastUserId})
			)`
			: Prisma.empty;

		const images = await prisma.$queryRaw<SearchResult[]>(Prisma.sql`
			WITH image_candidates AS (
				SELECT p.external_id AS id, p.user_id, p.provider
				FROM media p
				WHERE ${baseFilter}
				ORDER BY p.image_vec <=> ${textQuery}::vector, p.provider DESC, p.external_id DESC, p.user_id DESC
				LIMIT ${candidateLimit}
			),
			tag_candidates AS (
				SELECT p.external_id AS id, p.user_id, p.provider
				FROM media p
				WHERE ${baseFilter}
				ORDER BY p.tag_vec <=> ${textQuery}::vector, p.provider DESC, p.external_id DESC, p.user_id DESC
				LIMIT ${candidateLimit}
			),
			lexical_candidates AS (
				SELECT p.external_id AS id, p.user_id, p.provider
				FROM media p
				JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
				CROSS JOIN LATERAL (
					SELECT COALESCE(MAX(
						CASE
							WHEN lower(lexical_value.value) = ${queryLower} THEN 3
							WHEN lower(lexical_value.value) LIKE ${queryStartsWith} THEN 2
							WHEN lower(lexical_value.value) LIKE ${queryContains} THEN 1
							ELSE 0
						END
					), 0) AS lexical_score
					FROM jsonb_array_elements_text(
						COALESCE(p.classification->'characters', '[]'::jsonb)
						|| COALESCE(p.classification->'tags', '[]'::jsonb)
						|| to_jsonb(COALESCE(t.tags, ARRAY[]::text[]))
						|| jsonb_build_array(
							COALESCE(t.text, ''), COALESCE(t.title, ''),
							COALESCE(t.author_name, ''), COALESCE(t.author_username, '')
						)
					) AS lexical_value(value)
				) lexical_rank
				WHERE ${baseFilter}
					AND ${lexicalMatch}
				ORDER BY lexical_rank.lexical_score DESC, p.provider DESC, p.external_id DESC, p.user_id DESC
				LIMIT ${candidateLimit}
			),
			candidate_pool AS (
				SELECT DISTINCT id, user_id, provider
				FROM (
					SELECT id, user_id, provider FROM image_candidates
					UNION ALL
					SELECT id, user_id, provider FROM tag_candidates
					UNION ALL
					SELECT id, user_id, provider FROM lexical_candidates
				) candidates
			),
					scored AS (
					SELECT
						p.external_id AS media_id,
						p.provider,
						p.user_id,
						p.kind,
						${Prisma.raw(galleryDedupeKeySql("p"))} AS dedupe_key,
						p.height,
						p.width,
						p.original_url,
					p.s3_path,
					COALESCE(t.author_username, t.username) AS username,
					t.created_at AS post_created_at,
					t.external_id AS post_id,
					t.provider AS post_provider,
					t.source_url,
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
								WHEN lower(post_tag.value) = ${queryLower} THEN 0.76
								WHEN lower(post_tag.value) LIKE ${queryStartsWith} THEN 0.62
								WHEN lower(post_tag.value) LIKE ${queryContains} THEN 0.5
									ELSE 0.0
								END
							)
							FROM unnest(t.tags) AS post_tag(value)
						),
						0.0
					) AS s_post_tag,
					GREATEST(
						CASE WHEN lower(COALESCE(t.text, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END,
						CASE WHEN lower(COALESCE(t.title, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END,
						CASE WHEN lower(COALESCE(t.author_name, '')) LIKE ${queryContains} THEN 0.3 ELSE 0.0 END,
						CASE WHEN lower(COALESCE(t.author_username, '')) LIKE ${queryContains} THEN 0.3 ELSE 0.0 END
					) AS s_post_text
				FROM candidate_pool c
				JOIN media p ON p.external_id = c.id AND p.user_id = c.user_id AND p.provider = c.provider
				JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
			),
			fused AS (
					SELECT
						media_id,
						provider,
						user_id,
						kind,
						dedupe_key,
						height,
						width,
						original_url,
					s3_path,
					username,
					post_created_at,
					post_id,
						post_provider,
						source_url,
					is_nsfw,
					(
						(s_character * 0.44) +
						(GREATEST(s_tag_semantic, s_tag_lexical) * 0.28) +
						(GREATEST(s_post_tag, s_post_text) * 0.12) +
						(s_image * 0.1) +
						LEAST(0.04, GREATEST(0.0, aesthetic * (1.0 - style_real_life) * (0.65 + (style_anime * 0.35))) * 0.04) +
						(0.02 * EXP(LN(0.5) * (EXTRACT(EPOCH FROM (${queryTime}::timestamptz - post_created_at)) / (180.0 * 24 * 3600.0))))
					) AS final_score
				FROM scored
				),
				deduped AS (
					SELECT
						media_id,
						provider,
						user_id,
						kind,
						height,
						width,
						original_url,
						s3_path,
						username,
						post_created_at,
						post_id,
						post_provider,
						source_url,
						is_nsfw,
						final_score,
						ROW_NUMBER() OVER (
							PARTITION BY ${Prisma.raw(galleryDedupePartitionSql)}
							ORDER BY ${Prisma.raw(galleryRepresentativeOrderSql)}
						) AS duplicate_rank
					FROM fused
				),
				post_candidates AS (
					SELECT
						post_id,
						user_id,
						post_provider,
						final_score,
						ROW_NUMBER() OVER (
							PARTITION BY post_id, user_id, post_provider
							ORDER BY final_score DESC NULLS LAST
						) AS post_rank
					FROM deduped
					WHERE duplicate_rank = 1
				),
				ranked_posts AS (
					SELECT post_id, user_id, post_provider, final_score
					FROM post_candidates
					WHERE post_rank = 1
				),
				paged_posts AS (
					SELECT post_id, user_id, post_provider, final_score
					FROM ranked_posts
					${paginationClause}
					ORDER BY final_score DESC NULLS LAST, post_provider DESC, post_id DESC, user_id DESC
					LIMIT ${limit + 1}
				)
			SELECT
				p.external_id AS media_id,
				p.provider,
				p.user_id,
				p.kind,
				p.height,
				p.width,
				p.original_url,
				p.s3_path,
				t.username,
				t.created_at AS post_created_at,
				t.external_id AS post_id,
				t.provider AS post_provider,
				t.source_url,
				COALESCE((p.classification->'nsfw'->>'is_nsfw')::boolean, false) AS is_nsfw,
				paged_posts.final_score
			FROM paged_posts
			JOIN posts t ON t.external_id = paged_posts.post_id AND t.user_id = paged_posts.user_id AND t.provider = paged_posts.post_provider
			JOIN media p ON p.post_external_id = paged_posts.post_id AND p.user_id = paged_posts.user_id AND p.provider = paged_posts.post_provider
			WHERE p.deleted_at IS NULL AND p.s3_path IS NOT NULL
			ORDER BY paged_posts.final_score DESC NULLS LAST, paged_posts.post_provider DESC, paged_posts.post_id DESC, paged_posts.user_id DESC, p.position, p.created_at DESC, p.external_id DESC
		`);

		const page = paginateSearchResults(images, limit);
		const transformedResults = transformSearchResults(page.rows, env.BASE_CDN_URL);

		let nextCursor: string | null = null;
		if (page.hasNextPage && page.lastPost) {
			nextCursor = Cursor.create<SearchCursorPayload>({
				lastScore: page.lastPost.final_score,
				lastProvider: page.lastPost.post_provider,
				lastPostId: page.lastPost.post_id,
				lastUserId: page.lastPost.user_id,
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
                p.external_id AS id,
				p.user_id,
                p.provider,
                p.kind,
                ${Prisma.raw(galleryDedupeKeySql("p"))} AS dedupe_key,
                p.height,
                p.width,
                p.s3_path,
                p.original_url,
				COALESCE(t.author_username, t.username) AS username,
				t.created_at as post_created_at,
				t.external_id as post_id,
                t.provider as post_provider,
                t.source_url,
                (p.classification->>'aesthetic')::float AS aesthetic,
                (p.classification->'style'->>'anime')::float AS style_anime,
                (p.classification->'style'->>'real_life')::float AS style_real_life,
                (p.classification->'style'->>'other')::float AS style_other,
                (p.classification->'nsfw'->>'is_nsfw')::boolean AS is_nsfw
			FROM media p
			JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
			WHERE p.classification IS NOT NULL 
			AND p.deleted_at IS NULL
			AND p.kind = 'image'
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
					(1.0 - style_other) DESC,
					provider DESC, id DESC, user_id DESC
                ) AS rank_style,
				ROW_NUMBER() OVER (ORDER BY post_created_at DESC, provider DESC, id DESC, user_id DESC) AS rank_recency
            FROM base
        ),
        fused AS (
            SELECT
				id as media_id,
				user_id,
                provider,
                kind,
				dedupe_key,
                height,
                width,
                s3_path,
                original_url,
                username,
				post_created_at,
				post_id,
                post_provider,
                source_url,
                is_nsfw,
                (
                    (1.0 / (rank_style + 60) * 0.9) +
                    (1.0 / (rank_recency + 60) * 0.1)
                ) * effective * 
				EXP(LN(0.5) * (EXTRACT(EPOCH FROM (NOW() - post_created_at)) / (30.0 * 24 * 3600.0))) AS final_score
            FROM ranked
        ),
        deduped AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY ${Prisma.raw(galleryDedupePartitionSql)}
                ORDER BY ${Prisma.raw(galleryRepresentativeOrderSql)}
            ) AS duplicate_rank
            FROM fused
        ),
        top500 AS (
            SELECT * FROM deduped
            WHERE duplicate_rank = 1
            ORDER BY ${Prisma.raw(galleryRepresentativeOrderSql)}
            LIMIT 500
        )
        SELECT
			media_id,
			user_id,
			provider,
			kind,
            original_url,
            s3_path,
            username,
            height,
            width,
			post_created_at,
			post_id,
			post_provider,
			source_url,
            is_nsfw,
            final_score
        FROM top500
        ORDER BY RANDOM()
        LIMIT 30;
	`;

	return transformSearchResults(images, env.BASE_CDN_URL);
});

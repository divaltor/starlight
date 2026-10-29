import { ORPCError } from "@orpc/client";
import { Prisma, prisma } from "@starlight/utils";
import { z } from "zod";
import { publicProcedure } from "..";
import { maybeAuthProcedure } from "../middlewares/auth";
import { resolveQueryEmbedding } from "../services/embedding-cache";
import type { SearchResult } from "../types/tweets";
import { Cursor, SearchCursorPayloadSchema } from "../utils/cursor";
import type { SearchCursorPayload } from "../utils/cursor";
import { paginateSearchResults } from "../utils/search-pagination";
import { SearchRanking } from "../utils/search-ranking";
import { transformSearchResults } from "../utils/transformations";

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
    if (!context.config.embeddingsEnabled) {
      throw new ORPCError("Service not available, sorry!");
    }

    const { user } = context;
    const query = input.query.trim();
    const { cursor, limit, ownOnly } = input;

    if (ownOnly && !user) {
      throw new ORPCError("UNAUTHORIZED", {
        message: "Authentication required for personal search",
        status: 401,
      });
    }

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

    const { requestId } = context;
    const text = await resolveQueryEmbedding(async () => await context.generateTextEmbedding(query, requestId), query);

    if (!text) {
      throw new ORPCError("Failed to search images", {
        status: 500,
      });
    }

    let cursorData: SearchCursorPayload | null = null;

    if (cursor !== undefined && cursor !== "") {
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
    const ranking = SearchRanking.parseQuery(query);
    const candidateLimit = Math.max(limit * 8, 200);

    // Public user IDs are passed as a literal list: an `IN (SELECT ...)` semi-join makes the planner
    // expect ~2% of photos instead of nearly all, so it skips the HNSW indexes for an exact scan.
    const publicUsers =
      databaseUserId === null ? await prisma.user.findMany({ where: { isPublic: true }, select: { id: true } }) : [];

    const userFilter =
      databaseUserId === null
        ? Prisma.sql`p.user_id = ANY(${publicUsers.map((publicUser) => publicUser.id)}::uuid[])`
        : Prisma.sql`p.user_id = ${databaseUserId}`;

    const baseFilter = Prisma.sql`
			p.deleted_at IS NULL
			AND p.s3_path IS NOT NULL
			AND p.classification IS NOT NULL
			AND p.image_vec IS NOT NULL
			AND p.tag_vec IS NOT NULL
			AND ${userFilter}
		`;

    const paginationClause = cursorData
      ? Prisma.sql`WHERE (
				final_score < ${cursorData.lastScore}
				OR (final_score = ${cursorData.lastScore} AND tweet_id < ${cursorData.lastTweetId})
			)`
      : Prisma.empty;

    const images = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`;

      return await tx.$queryRaw<SearchResult[]>(Prisma.sql`
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
					AND ${SearchRanking.lexicalMatch(ranking)}
				ORDER BY t.created_at DESC, p.id DESC
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
						p.user_id,
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
					p.cosplay_score,
					${SearchRanking.lexicalScore(ranking)} AS s_lexical
				FROM candidate_pool c
				JOIN photos p ON p.id = c.id AND p.user_id = c.user_id
				JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
			),
			fused AS (
					SELECT
						photo_id,
						user_id,
						dedupe_key,
						height,
						width,
						original_url,
					s3_path,
					username,
					tweet_created_at,
					tweet_id,
					is_nsfw,
					${SearchRanking.finalScore({ cosplayWeight: ranking.cosplayWeight, queryTime })} AS final_score
				FROM scored
				),
				deduped AS (
					SELECT
						photo_id,
						user_id,
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
							ORDER BY final_score DESC NULLS LAST, tweet_created_at DESC, photo_id DESC, user_id DESC
						) AS duplicate_rank
					FROM fused
				),
				post_candidates AS (
					SELECT
						tweet_id,
						user_id,
						final_score,
						ROW_NUMBER() OVER (
							PARTITION BY tweet_id
							ORDER BY final_score DESC NULLS LAST, user_id DESC
						) AS post_rank
					FROM deduped
					WHERE duplicate_rank = 1
				),
				ranked_posts AS (
					SELECT tweet_id, user_id, final_score
					FROM post_candidates
					WHERE post_rank = 1
				),
				paged_posts AS (
					SELECT tweet_id, user_id, final_score
					FROM ranked_posts
					${paginationClause}
					ORDER BY final_score DESC NULLS LAST, tweet_id DESC
					LIMIT ${limit + 1}
				)
			SELECT
				p.id AS photo_id,
				p.height,
				p.width,
				p.original_url,
				p.s3_path,
				t.username,
				t.created_at AS tweet_created_at,
				t.id AS tweet_id,
				COALESCE((p.classification->'nsfw'->>'is_nsfw')::boolean, false) AS is_nsfw,
				paged_posts.final_score
			FROM paged_posts
			JOIN tweets t ON t.id = paged_posts.tweet_id AND t.user_id = paged_posts.user_id
			JOIN photos p ON p.tweet_id = paged_posts.tweet_id AND p.user_id = paged_posts.user_id
			WHERE p.deleted_at IS NULL AND p.s3_path IS NOT NULL
			ORDER BY paged_posts.final_score DESC NULLS LAST, paged_posts.tweet_id DESC, p.created_at DESC, p.id DESC
		`);
    });

    const page = paginateSearchResults(images, limit);
    const transformedResults = transformSearchResults(page.rows, context.config.baseCdnUrl);

    let nextCursor: string | null = null;

    if (page.hasNextPage && page.lastPost) {
      nextCursor = Cursor.create({
        lastScore: page.lastPost.final_score,
        lastTweetId: page.lastPost.tweet_id,
        queryTime,
      });
    }

    return {
      results: transformedResults,
      nextCursor,
    };
  });

export const randomImages = publicProcedure.handler(async ({ context }) => {
  // Rank on narrow tuples so window sorts stay in memory; display columns are
  // joined back only for the surviving top500. Decay math must stay float8 —
  // EXTRACT() yields numeric and EXP/LN on numeric is ~100ms slower at this scale.
  const images = await prisma.$queryRaw<SearchResult[]>`
		WITH core AS (
			SELECT
				p.id AS photo_id,
				p.user_id,
				t.id AS tweet_id,
				t.created_at AS ts,
				(p.classification->>'aesthetic')::float AS aesthetic,
				(p.classification->'style'->>'anime')::float AS style_anime,
				(p.classification->'style'->>'real_life')::float AS style_real_life,
				(p.classification->'style'->>'other')::float AS style_other
			FROM photos p
			JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
			WHERE p.deleted_at IS NULL
			AND p.classification IS NOT NULL
			AND p.user_id IN (SELECT id FROM users WHERE is_public = true)
			AND NOT (p.classification->'nsfw'->>'is_nsfw')::boolean
		),
		scored AS (
			SELECT *, aesthetic * style_anime * (1.0 - style_real_life) * (1.0 - style_other) AS effective
			FROM core
		),
		ranked AS (
			SELECT *,
				ROW_NUMBER() OVER (ORDER BY effective DESC) AS rank_style,
				ROW_NUMBER() OVER (ORDER BY ts DESC) AS rank_recency
			FROM scored
		),
		fused AS (
			SELECT photo_id, user_id, tweet_id, ts,
				((1.0 / (rank_style + 60) * 0.9) + (1.0 / (rank_recency + 60) * 0.1)) * effective *
				EXP(LN(0.5::float8) * (EXTRACT(EPOCH FROM (NOW() - ts))::float8 / 2592000.0)) AS final_score
			FROM ranked
		),
		top500 AS (
			SELECT * FROM fused ORDER BY final_score DESC LIMIT 500
		)
		SELECT
			z.photo_id,
			p.height,
			p.width,
			p.s3_path,
			p.original_url,
			t.username,
			t.created_at AS tweet_created_at,
			z.tweet_id,
			COALESCE((p.classification->'nsfw'->>'is_nsfw')::boolean, false) AS is_nsfw,
			z.final_score
		FROM top500 z
		JOIN tweets t ON t.id = z.tweet_id AND t.user_id = z.user_id
		JOIN photos p ON p.id = z.photo_id AND p.user_id = z.user_id
		ORDER BY RANDOM()
		LIMIT 30
	`;

  return transformSearchResults(images, context.config.baseCdnUrl);
});

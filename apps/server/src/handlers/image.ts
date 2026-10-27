import { FormattedString } from "@grammyjs/parse-mode";
import { CookieEncryption } from "@starlight/crypto";
import { resolveQueryEmbedding } from "@starlight/api/services/embedding-cache";
import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { SearchRanking } from "@starlight/api/utils/search-ranking";
import { isTwitterUrl, Prisma, prisma } from "@starlight/utils";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import env from "@/env";
import { webAppKeyboard } from "@/bot";
import type { Logger } from "@/logger";
import { scrapperQueue } from "@/queue/scrapper";
import { runtime } from "@/services/runtime";
import { Cookies } from "@/storage";
import type { Context } from "@/types";

const INLINE_QUERY_PAGE_SIZE = 50;

// Fixed across pages: scores are normalised over the candidate pool, so a pool
// that grew with depth would re-rank earlier pages and repeat photos.
const INLINE_QUERY_CANDIDATE_LIMIT = 400;

// The offset is client-controlled; clamping it bounds the legacy paging loop,
// which otherwise scans the whole tweet corpus accumulating every photo in
// memory while chasing a huge offset.
const MAX_INLINE_QUERY_PHOTO_OFFSET = 1000;
const INLINE_QUERY_AUTHOR_REGEX = /(?:^|\s)@(?<author>\w+)/gu;
const SET_COOKIES_LABEL = "Set cookies";

interface InlineImageSearchResult {
  photo_id: string;
  s3_path: string;
  tweet_id: string;
  username: string | null;
  height: number | null;
  width: number | null;
  final_score: number;
}

interface InlineQueryLogFields {
  candidateLimit?: number;
  pageQueryLimit?: number;
  pageSize?: number;
  photoOffset?: number;
  searchMode: string;
  tweetSkip?: number;
  userId: string;
}

async function runInlineImageQuery<T>(
  logger: Logger,
  fields: InlineQueryLogFields,
  query: () => Promise<T[]>,
): Promise<T[]> {
  const startedAt = performance.now();

  try {
    const results = await query();

    logger.debug(
      {
        ...fields,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        resultCount: results.length,
      },
      "Inline image database query completed",
    );

    return results;
  } catch (error) {
    logger.debug(
      {
        ...fields,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error,
      },
      "Inline image database query failed",
    );

    throw error;
  }
}

async function fetchLegacyTweetsPage(
  logger: Logger,
  userId: string,
  tweetSkip: number,
  whereClause: Prisma.TweetWhereInput,
) {
  return await runInlineImageQuery(
    logger,
    { searchMode: "legacy", userId, tweetSkip, pageSize: INLINE_QUERY_PAGE_SIZE },
    async () =>
      await prisma.tweet.findMany({
        where: {
          userId,
          photos: {
            some: {
              deletedAt: null,
              s3Path: { not: null },
            },
          },
          ...whereClause,
        },
        include: {
          photos: {
            where: {
              deletedAt: null,
              s3Path: { not: null },
            },
            orderBy: {
              createdAt: "desc",
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: INLINE_QUERY_PAGE_SIZE,
        skip: tweetSkip,
      }),
  );
}

async function searchInlineImagesWithLegacyQuery(
  logger: Logger,
  userId: string,
  query: string,
  photoOffset: number,
  pageQueryLimit: number,
): Promise<InlineImageSearchResult[]> {
  const allPhotos: InlineImageSearchResult[] = [];
  const seenPhotoKeys = new Set<string>();
  let tweetSkip = 0;

  const { authors, textQuery } = parseInlineImageQuery(query);
  const whereClause: Prisma.TweetWhereInput = {};

  if (authors.length > 0 && textQuery) {
    whereClause.AND = [
      {
        OR: authors.map((author) => ({
          username: { contains: author, mode: "insensitive" },
        })),
      },
      { tweetText: { contains: textQuery, mode: "insensitive" } },
    ];
  } else if (authors.length > 0) {
    whereClause.OR = authors.map((author) => ({
      username: { contains: author, mode: "insensitive" },
    }));
  } else if (textQuery) {
    whereClause.tweetText = { contains: textQuery, mode: "insensitive" };
  }

  while (allPhotos.length < photoOffset + pageQueryLimit) {
    const tweets = await fetchLegacyTweetsPage(logger, userId, tweetSkip, whereClause);

    if (tweets.length === 0) {
      break;
    }

    for (const tweet of tweets) {
      for (const photo of tweet.photos) {
        const hash = photo.perceptualHash?.trim();
        const dedupeKey = (hash ?? "") === "" ? photo.id : hash!;

        if (seenPhotoKeys.has(dedupeKey)) {
          continue;
        }

        seenPhotoKeys.add(dedupeKey);
        allPhotos.push({
          photo_id: photo.id,
          s3_path: photo.s3Path!,
          tweet_id: tweet.id,
          username: tweet.username,
          height: photo.height,
          width: photo.width,
          final_score: 0,
        });
      }
    }

    tweetSkip += INLINE_QUERY_PAGE_SIZE;
  }

  return allPhotos.slice(photoOffset, photoOffset + pageQueryLimit);
}

function parseInlineImageQuery(query: string) {
  const authors = [...query.matchAll(INLINE_QUERY_AUTHOR_REGEX)].map((match) => match.groups!.author!.toLowerCase());

  return {
    authors: [...new Set(authors)],
    textQuery: query.replaceAll(INLINE_QUERY_AUTHOR_REGEX, " ").replaceAll(/\s+/gu, " ").trim(),
  };
}

async function getInlineQueryEmbedding(query: string) {
  const hasMlUrl = (env.ML_BASE_URL ?? "") !== "";
  const hasMlToken = (env.ML_API_TOKEN ?? "") !== "";

  if (!env.ENABLE_EMBEDDINGS || !hasMlUrl || !hasMlToken) {
    return null;
  }

  return await resolveQueryEmbedding(
    async () => await runtime.runPromise(EmbeddingsService.Service.use((s) => s.generateText(query))),
    query,
  );
}

interface InlineLexicalFragmentInputs {
  queryContains: string;
  queryLower: string;
  queryStartsWith: string;
  queryStartsWithSeries: string;
}

function buildAuthorFilters(authors: string[]): { filter: Prisma.Sql; score: Prisma.Sql } {
  if (authors.length === 0) {
    return { filter: Prisma.empty, score: Prisma.sql`0.0` };
  }

  const filter = Prisma.sql`AND (${Prisma.join(
    authors.map((author) => Prisma.sql`strpos(lower(COALESCE(t.username, '')), ${author}) > 0`),
    " OR ",
  )})`;

  const score = Prisma.sql`GREATEST(${Prisma.join(
    authors.map(
      (author) =>
        Prisma.sql`CASE
									WHEN lower(COALESCE(t.username, '')) = ${author} THEN 1.0
									WHEN strpos(lower(COALESCE(t.username, '')), ${author}) = 1 THEN 0.88
									WHEN strpos(lower(COALESCE(t.username, '')), ${author}) > 0 THEN 0.76
									ELSE 0.0
								END`,
    ),
    ", ",
  )})`;

  return { filter, score };
}

function buildLexicalMatch(inputs: InlineLexicalFragmentInputs): Prisma.Sql {
  const { queryContains, queryLower, queryStartsWith, queryStartsWithSeries } = inputs;

  return Prisma.sql`
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
			`;
}

function buildCharacterScore(inputs: InlineLexicalFragmentInputs): Prisma.Sql {
  const { queryContains, queryLower, queryStartsWith, queryStartsWithSeries } = inputs;

  return Prisma.sql`
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
				)
			`;
}

function buildTagLexicalScore(inputs: InlineLexicalFragmentInputs): Prisma.Sql {
  const { queryContains, queryLower, queryStartsWith } = inputs;

  return Prisma.sql`
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
				)
			`;
}

function buildHashtagScore(inputs: InlineLexicalFragmentInputs): Prisma.Sql {
  const { queryContains, queryLower, queryStartsWith } = inputs;

  return Prisma.sql`
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
				)
			`;
}

interface SemanticInlineSearch {
  authorFilter: Prisma.Sql;
  authorScore: Prisma.Sql;
  characterScore: Prisma.Sql;
  cosplayWeight: number;
  cursor: InlineSearchCursor.Payload | null;
  hashtagScore: Prisma.Sql;
  lexicalMatch: Prisma.Sql;
  logger: Logger;
  pageQueryLimit: number;
  photoDedupeKey: Prisma.Sql;
  queryTime: string;
  tagLexicalScore: Prisma.Sql;
  textVector: string;
  tweetTextScore: Prisma.Sql;
  userId: string;
}

async function runSemanticInlineSearch(search: SemanticInlineSearch): Promise<InlineImageSearchResult[]> {
  const {
    authorFilter,
    authorScore,
    characterScore,
    cosplayWeight,
    cursor,
    hashtagScore,
    lexicalMatch,
    logger,
    pageQueryLimit,
    photoDedupeKey,
    queryTime,
    tagLexicalScore,
    textVector,
    tweetTextScore,
    userId,
  } = search;

  return await runInlineImageQuery(
    logger,
    { searchMode: "semantic", userId, pageQueryLimit, candidateLimit: INLINE_QUERY_CANDIDATE_LIMIT },
    async () =>
      await prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
					WITH image_candidates AS (
						SELECT p.id, p.user_id
						FROM photos p
						JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.s3_path IS NOT NULL
							AND p.classification IS NOT NULL
							AND p.image_vec IS NOT NULL
							AND p.tag_vec IS NOT NULL
							${authorFilter}
						ORDER BY p.image_vec <=> ${textVector}::vector
						LIMIT ${INLINE_QUERY_CANDIDATE_LIMIT}
					),
					tag_candidates AS (
						SELECT p.id, p.user_id
						FROM photos p
						JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.s3_path IS NOT NULL
							AND p.classification IS NOT NULL
							AND p.image_vec IS NOT NULL
							AND p.tag_vec IS NOT NULL
							${authorFilter}
						ORDER BY p.tag_vec <=> ${textVector}::vector
						LIMIT ${INLINE_QUERY_CANDIDATE_LIMIT}
					),
					lexical_candidates AS (
						SELECT p.id, p.user_id
						FROM photos p
						JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.s3_path IS NOT NULL
							AND ${lexicalMatch}
							${authorFilter}
						ORDER BY t.created_at DESC, p.id DESC
						LIMIT ${INLINE_QUERY_CANDIDATE_LIMIT}
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
							${photoDedupeKey} AS dedupe_key,
							p.s3_path,
							p.height,
							p.width,
							t.username,
							t.id AS tweet_id,
							t.created_at AS tweet_created_at,
							COALESCE(1.0 - (p.image_vec <=> ${textVector}::vector), 0.0) AS s_image,
							COALESCE(1.0 - (p.tag_vec <=> ${textVector}::vector), 0.0) AS s_tag_semantic,
							p.cosplay_score,
							${characterScore} AS s_character,
							${tagLexicalScore} AS s_tag_lexical,
							${hashtagScore} AS s_hashtag,
							${tweetTextScore} AS s_tweet_text,
							${authorScore} AS s_author
						FROM candidate_pool c
						JOIN photos p ON p.id = c.id AND p.user_id = c.user_id
						JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
					),
					fused AS (
						SELECT
							photo_id,
							dedupe_key,
							s3_path,
							tweet_id,
							username,
							tweet_created_at,
							height,
							width,
							-- Author match keeps its old 0.2 ratio to a character match.
							${SearchRanking.finalScore({ cosplayWeight, queryTime })} + (s_author * 0.8) AS final_score
						FROM scored
					),
					deduped AS (
						SELECT
							photo_id,
							s3_path,
							tweet_id,
							username,
							height,
							width,
							final_score,
							ROW_NUMBER() OVER (
								PARTITION BY dedupe_key
								ORDER BY final_score DESC NULLS LAST, tweet_created_at DESC, photo_id DESC
							) AS duplicate_rank
						FROM fused
					)
					SELECT photo_id, s3_path, tweet_id, username, height, width, final_score
					FROM deduped
					WHERE duplicate_rank = 1
						${
              cursor
                ? Prisma.sql`AND (final_score, photo_id) < (${cursor.lastScore}::float8, ${cursor.lastPhotoId})`
                : Prisma.empty
            }
					ORDER BY final_score DESC NULLS LAST, photo_id DESC
					LIMIT ${pageQueryLimit}
						`),
  );
}

interface RecencyInlineSearch {
  authorFilter: Prisma.Sql;
  logger: Logger;
  pageQueryLimit: number;
  photoDedupeKey: Prisma.Sql;
  photoOffset: number;
  userId: string;
}

async function runRecencyInlineSearch(search: RecencyInlineSearch): Promise<InlineImageSearchResult[]> {
  const { authorFilter, logger, pageQueryLimit, photoDedupeKey, photoOffset, userId } = search;

  return await runInlineImageQuery(
    logger,
    { searchMode: "recency", userId, photoOffset, pageQueryLimit },
    async () =>
      await prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
					WITH ranked AS (
						SELECT
							p.id AS photo_id,
							p.s3_path,
							t.id AS tweet_id,
							t.username,
							p.height,
							p.width,
							p.created_at AS photo_created_at,
							ROW_NUMBER() OVER (
								PARTITION BY ${photoDedupeKey}
								ORDER BY p.created_at DESC, p.id DESC
							) AS duplicate_rank
						FROM photos p
						JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.s3_path IS NOT NULL
							${authorFilter}
					)
					SELECT
						photo_id,
						s3_path,
						tweet_id,
						username,
						height,
						width,
						0.0 AS final_score
					FROM ranked
					WHERE duplicate_rank = 1
					ORDER BY photo_created_at DESC, photo_id DESC
					OFFSET ${photoOffset}
					LIMIT ${pageQueryLimit}
				`),
  );
}

interface RankedInlinePhotoSearch {
  authors: string[];
  logger: Logger;
  offset: string;
  query: string;
  textQuery: string;
  userId: string | undefined;
}

async function searchRankedInlinePhotos(
  search: RankedInlinePhotoSearch,
): Promise<{ photos: InlineImageSearchResult[]; nextOffset: string }> {
  const { authors, logger, offset, query, textQuery, userId } = search;

  const ranking = SearchRanking.parseQuery(textQuery);
  const queryLower = ranking.lexicalQuery.toLowerCase();
  const hasLexicalQuery = queryLower.length > 0;
  const queryContains = `%${queryLower}%`;
  const queryStartsWith = `${queryLower}%`;
  const queryStartsWithSeries = `${queryLower} (%`;
  const pageQueryLimit = INLINE_QUERY_PAGE_SIZE + 1;
  const photoOffset = Math.min(Math.max(Number(offset || "0") || 0, 0), MAX_INLINE_QUERY_PHOTO_OFFSET);
  const photoDedupeKey = Prisma.sql`COALESCE(NULLIF(p.perceptual_hash, ''), p.id)`;

  const fragmentInputs = {
    queryContains,
    queryLower,
    queryStartsWith,
    queryStartsWithSeries,
  };

  const authorFilters = buildAuthorFilters(authors);
  const authorFilter = authorFilters.filter;
  const authorScore = authorFilters.score;
  const lexicalMatch = hasLexicalQuery ? buildLexicalMatch(fragmentInputs) : Prisma.sql`FALSE`;
  const characterScore = hasLexicalQuery ? buildCharacterScore(fragmentInputs) : Prisma.sql`0.0`;
  const tagLexicalScore = hasLexicalQuery ? buildTagLexicalScore(fragmentInputs) : Prisma.sql`0.0`;
  const hashtagScore = hasLexicalQuery ? buildHashtagScore(fragmentInputs) : Prisma.sql`0.0`;

  const tweetTextScore = hasLexicalQuery
    ? Prisma.sql`CASE WHEN lower(COALESCE(t.tweet_text, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END`
    : Prisma.sql`0.0`;

  if (userId === undefined || userId === "") {
    return { photos: [], nextOffset: "" };
  }

  if (textQuery === "") {
    const photos = await runRecencyInlineSearch({
      authorFilter,
      logger,
      pageQueryLimit,
      photoDedupeKey,
      photoOffset,
      userId,
    });

    return {
      photos: photos.slice(0, INLINE_QUERY_PAGE_SIZE),
      nextOffset: photos.length > INLINE_QUERY_PAGE_SIZE ? String(photoOffset + INLINE_QUERY_PAGE_SIZE) : "",
    };
  }

  let textEmbedding: number[] | null = null;

  try {
    textEmbedding = await getInlineQueryEmbedding(textQuery);
  } catch (error) {
    logger.warn({ error, query: textQuery }, "Inline image semantic search unavailable");
  }

  if (!textEmbedding) {
    const photos = await searchInlineImagesWithLegacyQuery(logger, userId, query, photoOffset, pageQueryLimit);

    return {
      photos: photos.slice(0, INLINE_QUERY_PAGE_SIZE),
      nextOffset: photos.length > INLINE_QUERY_PAGE_SIZE ? String(photoOffset + INLINE_QUERY_PAGE_SIZE) : "",
    };
  }

  const cursor = InlineSearchCursor.parse(offset);
  // Frozen for the whole paging session so recency decay scores every page alike.
  const queryTime = cursor?.queryTime ?? new Date();

  const photos = await runSemanticInlineSearch({
    authorFilter,
    authorScore,
    characterScore,
    cosplayWeight: ranking.cosplayWeight,
    cursor,
    hashtagScore,
    lexicalMatch,
    logger,
    pageQueryLimit,
    photoDedupeKey,
    queryTime: queryTime.toISOString(),
    tagLexicalScore,
    textVector: `[${textEmbedding.join(",")}]`,
    tweetTextScore,
    userId,
  });

  const page = photos.slice(0, INLINE_QUERY_PAGE_SIZE);
  const lastPhoto = page.at(-1);

  return {
    photos: page,
    nextOffset:
      photos.length > INLINE_QUERY_PAGE_SIZE && lastPhoto
        ? InlineSearchCursor.create({ lastPhotoId: lastPhoto.photo_id, lastScore: lastPhoto.final_score, queryTime })
        : "",
  };
}

// Telegram caps next_offset at 64 bytes, too small for the mini app's base64 JSON cursor,
// so this one is `<queryTimeMs>_<lastScore>_<lastPhotoId>` (at most ~57 bytes).
namespace InlineSearchCursor {
  const CURSOR_REGEX = /^(?<queryTime>\d{13})_(?<lastScore>[^_]+)_(?<lastPhotoId>\d+)$/u;

  export interface Payload {
    lastPhotoId: string;
    lastScore: number;
    queryTime: Date;
  }

  export function create(payload: Payload) {
    return `${payload.queryTime.getTime()}_${payload.lastScore}_${payload.lastPhotoId}`;
  }

  // Any other offset, such as a numeric one from recency or legacy paging, restarts at the first page.
  export function parse(offset: string): Payload | null {
    const groups = CURSOR_REGEX.exec(offset)?.groups;

    if (!groups) {
      return null;
    }

    return {
      queryTime: new Date(Number(groups.queryTime)),
      lastScore: Number(groups.lastScore),
      lastPhotoId: groups.lastPhotoId!,
    };
  }
}

const cookieEncryption = new CookieEncryption(env.COOKIE_ENCRYPTION_KEY, env.COOKIE_ENCRYPTION_SALT);

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");

composer
  .on("inline_query")
  .filter((ctx) => !isTwitterUrl(ctx.inlineQuery.query.trim()))
  .use(async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const { authors, textQuery } = parseInlineImageQuery(query);

    const page = await searchRankedInlinePhotos({
      authors,
      logger: ctx.logger,
      offset: ctx.inlineQuery.offset,
      query,
      textQuery,
      userId: ctx.user?.id,
    });

    if (
      page.photos.length === 0 &&
      (ctx.user?.cookies === undefined || ctx.user.cookies === null || ctx.user.cookies === "")
    ) {
      // User didn't setup the bot yet
      await ctx.answerInlineQuery(
        [
          InlineQueryResultBuilder.article(`id:no-photos:${ctx.from?.id}`, "Oops, no photos...", {
            reply_markup: new InlineKeyboard().url(SET_COOKIES_LABEL, `${env.BASE_FRONTEND_URL}/settings`),
          }).text("No photos found, did you setup the bot?"),
        ],
        {
          is_personal: true,
        },
      );

      return;
    }

    const results = page.photos.map((photo) => {
      const photoUrl = `${env.BASE_CDN_URL}/${photo.s3_path}`;

      const caption =
        photo.username !== null && photo.username !== ""
          ? FormattedString.link(`@${photo.username}`, `https://x.com/i/status/${photo.tweet_id}`)
          : new FormattedString(`https://x.com/i/status/${photo.tweet_id}`);

      return InlineQueryResultBuilder.photo(photo.photo_id, photoUrl, {
        caption: caption.caption,
        caption_entities: caption.caption_entities,
        thumbnail_url: photoUrl,
        photo_height: photo.height ?? undefined,
        photo_width: photo.width ?? undefined,
      });
    });

    await ctx.answerInlineQuery(results, {
      next_offset: page.nextOffset,
      is_personal: true,
      cache_time: 30,
    });
  });

privateChat
  .command("cookies")
  .filter((ctx) => ctx.user?.cookies === undefined || ctx.user.cookies === null || ctx.user.cookies === "")
  .use(async (ctx) => {
    const keyboard = new InlineKeyboard().webApp(SET_COOKIES_LABEL, {
      url: `${env.BASE_FRONTEND_URL}/settings`,
    });

    await ctx.reply("No cookies found. Please set your cookies first.", {
      reply_markup: keyboard,
    });
  });

privateChat
  .command("cookies")
  .filter((ctx) => Boolean(ctx.user?.cookies))
  .use(async (ctx) => {
    try {
      const userCookies = ctx.user?.cookies;

      if (userCookies === undefined || userCookies === null || userCookies === "" || ctx.user === undefined) {
        await ctx.reply("No cookies found.");

        return;
      }

      const cookiesJson = cookieEncryption.safeDecrypt(userCookies, ctx.user.telegramId.toString());

      const cookies = Cookies.fromJSON(cookiesJson);
      const cookiesString = cookies.toString();

      await ctx.reply(`Your cookies:\n\n${cookiesString}`);
    } catch (error) {
      ctx.logger.error({ error }, "Failed to decrypt cookies");
      await ctx.reply("Failed to decrypt cookies. Please try setting them again.");
    }
  });

privateChat
  .command("scrapper")
  .filter((ctx) => ctx.user?.cookies === undefined || ctx.user.cookies === null || ctx.user.cookies === "")
  .use(async (ctx) => {
    const keyboard = new InlineKeyboard().webApp(SET_COOKIES_LABEL, {
      url: `${env.BASE_FRONTEND_URL}/cookies`,
    });

    await ctx.reply("Beep boop, you need to give me your cookies before I can send you daily images.", {
      reply_markup: keyboard,
    });
  });

privateChat
  .command("scrapper")
  .filter((ctx) => Boolean(ctx.user?.cookies))
  .use(async (ctx) => {
    const user = ctx.user!;
    const schedulerId = `scrapper-${user.id}`;
    const scheduledJob = await scrapperQueue.getJobScheduler(schedulerId);

    if (scheduledJob) {
      await scrapperQueue.add(
        "scrapper",
        { userId: user.id, count: 0, limit: 100 },
        { deduplication: { id: schedulerId } },
      );

      await ctx.reply("Starting to collect images, check back in a few minutes.");
    } else {
      ctx.logger.debug({ userId: user.id }, "Scheduled scrapper");

      await scrapperQueue.upsertJobScheduler(
        schedulerId,
        {
          every: 1000 * 60 * 60 * 6,
        },
        {
          data: { userId: user.id, count: 0, limit: 300 },
          name: schedulerId,
        },
      );

      await ctx.reply(
        "You placed in the queue (runs every 6 hours). You can check your images in a few minutes in your gallery.\n\nYou can start the job anytime by sending /scrapper command again.",
        {
          reply_markup: webAppKeyboard("app", "View gallery"),
        },
      );
    }
  });

export default composer;

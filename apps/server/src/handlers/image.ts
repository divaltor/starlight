import { FormattedString } from "@grammyjs/parse-mode";
import { CookieEncryption } from "@starlight/crypto";
import { resolveQueryEmbedding } from "@starlight/api/services/embedding-cache";
import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { env, isTwitterUrl, Prisma, prisma } from "@starlight/utils";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import { webAppKeyboard } from "@/bot";
import type { Logger } from "@/logger";
import { scrapperQueue } from "@/queue/scrapper";
import { runtime } from "@/services/runtime";
import { Cookies } from "@/storage";
import type { Context } from "@/types";

const INLINE_QUERY_PAGE_SIZE = 50;
const INLINE_QUERY_CANDIDATE_MULTIPLIER = 8;
const INLINE_QUERY_AUTHOR_REGEX = /(?:^|\s)@(?<author>[A-Za-z0-9_]+)/gu;
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
		() =>
			prisma.tweet.findMany({
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

	while (allPhotos.length < photoOffset + pageQueryLimit) {
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

		const tweets = await fetchLegacyTweetsPage(logger, userId, tweetSkip, whereClause);

		if (tweets.length === 0) {
			break;
		}

		for (const tweet of tweets) {
			for (const photo of tweet.photos) {
				const dedupeKey = photo.perceptualHash?.trim() || photo.id;

				if (seenPhotoKeys.has(dedupeKey)) {
					continue;
				}

				seenPhotoKeys.add(dedupeKey);
				allPhotos.push({
					photo_id: photo.id,
					s3_path: photo.s3Path as string,
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
	const authors = [...query.matchAll(INLINE_QUERY_AUTHOR_REGEX)].map((match) =>
		match.groups!.author!.toLowerCase(),
	);

	return {
		authors: [...new Set(authors)],
		textQuery: query.replace(INLINE_QUERY_AUTHOR_REGEX, " ").replaceAll(/\s+/gu, " ").trim(),
	};
}

function getInlineQueryEmbedding(query: string) {
	if (!(env.ENABLE_EMBEDDINGS && env.ML_BASE_URL && env.ML_API_TOKEN)) {
		return Promise.resolve<number[] | null>(null);
	}

	return resolveQueryEmbedding(
		() => runtime.runPromise(EmbeddingsService.Service.use((s) => s.generateText(query))),
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
	candidateLimit: number;
	characterScore: Prisma.Sql;
	hashtagScore: Prisma.Sql;
	lexicalMatch: Prisma.Sql;
	logger: Logger;
	pageQueryLimit: number;
	photoDedupeKey: Prisma.Sql;
	photoOffset: number;
	queryTime: string;
	tagLexicalScore: Prisma.Sql;
	textVector: string;
	tweetTextScore: Prisma.Sql;
	userId: string;
}

async function runSemanticInlineSearch(
	search: SemanticInlineSearch,
): Promise<InlineImageSearchResult[]> {
	const {
		authorFilter,
		authorScore,
		candidateLimit,
		characterScore,
		hashtagScore,
		lexicalMatch,
		logger,
		pageQueryLimit,
		photoDedupeKey,
		photoOffset,
		queryTime,
		tagLexicalScore,
		textVector,
		tweetTextScore,
		userId,
	} = search;

	return await runInlineImageQuery(
		logger,
		{ searchMode: "semantic", userId, photoOffset, pageQueryLimit, candidateLimit },
		() =>
			prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
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
						LIMIT ${candidateLimit}
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
						LIMIT ${candidateLimit}
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
							${photoDedupeKey} AS dedupe_key,
							p.s3_path,
							p.height,
							p.width,
							t.username,
							t.id AS tweet_id,
							t.created_at AS tweet_created_at,
							COALESCE(1.0 - (p.image_vec <=> ${textVector}::vector), 0.0) AS s_image,
							COALESCE(1.0 - (p.tag_vec <=> ${textVector}::vector), 0.0) AS s_tag_semantic,
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
							(
								(s_character * 0.4) +
								(GREATEST(s_tag_semantic, s_tag_lexical) * 0.24) +
								(GREATEST(s_hashtag, s_tweet_text) * 0.12) +
								(s_image * 0.1) +
								(s_author * 0.08) +
								(0.02 * EXP(LN(0.5) * (EXTRACT(EPOCH FROM (${queryTime}::timestamptz - tweet_created_at)) / (180.0 * 24 * 3600.0))))
							) AS final_score
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
					ORDER BY final_score DESC NULLS LAST, photo_id DESC
					OFFSET ${photoOffset}
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

async function runRecencyInlineSearch(
	search: RecencyInlineSearch,
): Promise<InlineImageSearchResult[]> {
	const { authorFilter, logger, pageQueryLimit, photoDedupeKey, photoOffset, userId } = search;

	return await runInlineImageQuery(
		logger,
		{ searchMode: "recency", userId, photoOffset, pageQueryLimit },
		() =>
			prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
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
	photoOffset: number;
	query: string;
	textQuery: string;
	userId: string | undefined;
}

async function searchRankedInlinePhotos(
	search: RankedInlinePhotoSearch,
): Promise<InlineImageSearchResult[]> {
	const { authors, logger, photoOffset, query, textQuery, userId } = search;

	const queryLower = textQuery.toLowerCase();
	const hasTextQuery = queryLower.length > 0;
	const queryContains = `%${queryLower}%`;
	const queryStartsWith = `${queryLower}%`;
	const queryStartsWithSeries = `${queryLower} (%`;
	const pageQueryLimit = INLINE_QUERY_PAGE_SIZE + 1;
	const candidateLimit = Math.max(
		(photoOffset + pageQueryLimit) * INLINE_QUERY_CANDIDATE_MULTIPLIER,
		200,
	);
	const queryTime = new Date().toISOString();
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
	const lexicalMatch = hasTextQuery ? buildLexicalMatch(fragmentInputs) : Prisma.sql`FALSE`;
	const characterScore = hasTextQuery ? buildCharacterScore(fragmentInputs) : Prisma.sql`0.0`;
	const tagLexicalScore = hasTextQuery ? buildTagLexicalScore(fragmentInputs) : Prisma.sql`0.0`;
	const hashtagScore = hasTextQuery ? buildHashtagScore(fragmentInputs) : Prisma.sql`0.0`;
	const tweetTextScore = hasTextQuery
		? Prisma.sql`CASE WHEN lower(COALESCE(t.tweet_text, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END`
		: Prisma.sql`0.0`;

	if (!userId) {
		return [];
	}

	if (!hasTextQuery) {
		return await runRecencyInlineSearch({
			authorFilter,
			logger,
			pageQueryLimit,
			photoDedupeKey,
			photoOffset,
			userId,
		});
	}

	let textEmbedding: number[] | null = null;

	try {
		textEmbedding = await getInlineQueryEmbedding(textQuery);
	} catch (error) {
		logger.warn({ error, query: textQuery }, "Inline image semantic search unavailable");
	}

	if (!textEmbedding) {
		return await searchInlineImagesWithLegacyQuery(
			logger,
			userId,
			query,
			photoOffset,
			pageQueryLimit,
		);
	}

	return await runSemanticInlineSearch({
		authorFilter,
		authorScore,
		candidateLimit,
		characterScore,
		hashtagScore,
		lexicalMatch,
		logger,
		pageQueryLimit,
		photoDedupeKey,
		photoOffset,
		queryTime,
		tagLexicalScore,
		textVector: `[${textEmbedding.join(",")}]`,
		tweetTextScore,
		userId,
	});
}

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");

composer
	.on("inline_query")
	.filter((ctx) => !isTwitterUrl(ctx.inlineQuery.query.trim()))
	.use(async (ctx) => {
		const photoOffset = Number(ctx.inlineQuery.offset || "0") || 0;
		const query = ctx.inlineQuery.query.trim();
		const { authors, textQuery } = parseInlineImageQuery(query);

		const rankedPhotos = await searchRankedInlinePhotos({
			authors,
			logger: ctx.logger,
			photoOffset,
			query,
			textQuery,
			userId: ctx.user?.id,
		});

		const photosForThisPage = rankedPhotos.slice(0, INLINE_QUERY_PAGE_SIZE);

		if (photosForThisPage.length === 0 && !ctx.user?.cookies) {
			// User didn't setup the bot yet
			await ctx.answerInlineQuery(
				[
					InlineQueryResultBuilder.article(`id:no-photos:${ctx.from?.id}`, "Oops, no photos...", {
						reply_markup: new InlineKeyboard().url(
							SET_COOKIES_LABEL,
							`${env.BASE_FRONTEND_URL}/settings`,
						),
					}).text("No photos found, did you setup the bot?"),
				],
				{
					is_personal: true,
				},
			);

			return;
		}

		const results = photosForThisPage.map((photo) => {
			const photoUrl = `${env.BASE_CDN_URL}/${photo.s3_path}`;
			const caption = photo.username
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

		// Calculate next offset for pagination
		let nextOffset = "";
		if (rankedPhotos.length > INLINE_QUERY_PAGE_SIZE) {
			nextOffset = String(photoOffset + INLINE_QUERY_PAGE_SIZE);
		}

		await ctx.answerInlineQuery(results, {
			next_offset: nextOffset,
			is_personal: true,
			cache_time: 30,
		});
	});

privateChat
	.command("cookies")
	.filter((ctx) => !ctx.user?.cookies)
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

			if (!(userCookies && ctx.user)) {
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
	.filter((ctx) => !ctx.user?.cookies)
	.use(async (ctx) => {
		const keyboard = new InlineKeyboard().webApp(SET_COOKIES_LABEL, {
			url: `${env.BASE_FRONTEND_URL}/cookies`,
		});

		await ctx.reply(
			"Beep boop, you need to give me your cookies before I can send you daily images.",
			{ reply_markup: keyboard },
		);
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

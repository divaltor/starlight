import { FormattedString } from "@grammyjs/parse-mode";
import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { hasTwitterCookies } from "@starlight/api/services/twitter-credential";
import { env, isTwitterUrl, Prisma, prisma } from "@starlight/utils";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import { webAppKeyboard } from "@/bot";
import type { Logger } from "@/logger";
import { RETRY } from "@/queue/absurd";
import { getScheduledScrapperGeneration, scrapperApp } from "@/queue/scrapper";
import { runtime } from "@/services/runtime";
import type { Context } from "@/types";
import {
	createInlineImageDedupeKey,
	createInlineImageResultId,
} from "@/utils/inline-image-identity";

const INLINE_QUERY_PAGE_SIZE = 50;
const INLINE_QUERY_CANDIDATE_MULTIPLIER = 8;
const INLINE_QUERY_AUTHOR_REGEX = /(^|\s)@([A-Za-z0-9_]+)/g;

type InlineImageSearchResult = {
	photo_id: string;
	photo_provider: string;
	photo_user_id: string;
	s3_path: string;
	tweet_id: string;
	source_url: string;
	username: string | null;
	height: number | null;
	width: number | null;
	final_score: number;
};

async function runInlineImageQuery<T>(
	logger: Logger,
	fields: Record<string, unknown>,
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
		const whereClause: Prisma.PostWhereInput = {};

		if (authors.length > 0 && textQuery) {
			whereClause.AND = [
				{
					OR: authors.map((author) => ({
						authorUsername: { contains: author, mode: "insensitive" },
					})),
				},
				{
					OR: [
						{ text: { contains: textQuery, mode: "insensitive" } },
						{ title: { contains: textQuery, mode: "insensitive" } },
						{ tags: { has: textQuery } },
					],
				},
			];
		} else if (authors.length > 0) {
			whereClause.OR = authors.map((author) => ({
				authorUsername: { contains: author, mode: "insensitive" },
			}));
		} else if (textQuery) {
			whereClause.OR = [
				{ text: { contains: textQuery, mode: "insensitive" } },
				{ title: { contains: textQuery, mode: "insensitive" } },
				{ tags: { has: textQuery } },
			];
		}

		const tweets = await runInlineImageQuery(
			logger,
			{ searchMode: "legacy", userId, tweetSkip, pageSize: INLINE_QUERY_PAGE_SIZE },
			() =>
				prisma.post.findMany({
					where: {
						userId,
						photos: {
							some: {
								deletedAt: null,
								kind: "image",
								s3Path: { not: null },
							},
						},
						...whereClause,
					},
					include: {
						photos: {
							where: {
								deletedAt: null,
								kind: "image",
								s3Path: { not: null },
							},
							orderBy: [{ createdAt: "desc" }, { provider: "desc" }, { id: "desc" }],
						},
					},
					orderBy: [{ createdAt: "desc" }, { provider: "desc" }, { id: "desc" }],
					take: INLINE_QUERY_PAGE_SIZE,
					skip: tweetSkip,
				}),
		);

		if (tweets.length === 0) {
			break;
		}

		for (const tweet of tweets) {
			for (const photo of tweet.photos) {
				const dedupeKey = createInlineImageDedupeKey(
					photo.provider,
					photo.id,
					photo.userId,
					photo.perceptualHash,
				);

				if (seenPhotoKeys.has(dedupeKey)) {
					continue;
				}

				seenPhotoKeys.add(dedupeKey);
				allPhotos.push({
					photo_id: photo.id,
					photo_provider: photo.provider,
					photo_user_id: photo.userId,
					s3_path: photo.s3Path as string,
					tweet_id: tweet.id,
					source_url: tweet.sourceUrl,
					username: tweet.authorUsername ?? tweet.username,
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
	const authors = [...query.matchAll(INLINE_QUERY_AUTHOR_REGEX)].map(([, , author]) =>
		author!.toLowerCase(),
	);

	return {
		authors: [...new Set(authors)],
		textQuery: query.replace(INLINE_QUERY_AUTHOR_REGEX, " ").replace(/\s+/g, " ").trim(),
	};
}

async function getInlineQueryEmbedding(query: string) {
	if (!(env.ENABLE_EMBEDDINGS && env.ML_BASE_URL && env.ML_API_TOKEN)) {
		return null;
	}

	const queryHash = BigInt.asIntN(64, BigInt(Bun.hash.xxHash3(query)));

	const [cached] = await prisma.$queryRaw<Array<{ embedding: string }>>(
		Prisma.sql`SELECT embedding FROM embedding_cache WHERE query = ${queryHash}`,
	);

	if (cached) {
		return JSON.parse(cached.embedding) as number[];
	}

	const text = await runtime.runPromise(
		EmbeddingsService.Service.use((s) => s.generateText(query)),
	);

	if (!text) {
		throw new Error("Inline image search embeddings failed");
	}

	const vecStr = `[${text.join(",")}]`;
	await prisma.$executeRaw(
		Prisma.sql`INSERT INTO embedding_cache (query, embedding, updated_at) VALUES (${queryHash}, ${vecStr}::vector, NOW()) ON CONFLICT (query) DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = NOW()`,
	);

	return text;
}

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");

composer.on("inline_query").filter(
	(ctx) => !isTwitterUrl(ctx.inlineQuery.query.trim()),
	async (ctx) => {
		const photoOffset = Number(ctx.inlineQuery.offset || "0") || 0;
		const query = ctx.inlineQuery.query.trim();
		const userId = ctx.user?.id;
		const { authors, textQuery } = parseInlineImageQuery(query);
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
		const photoDedupeKey = Prisma.sql`jsonb_build_array(
			CASE WHEN NULLIF(p.perceptual_hash, '') IS NULL THEN 'identity' ELSE 'hash' END,
			p.provider,
			COALESCE(NULLIF(p.perceptual_hash, ''), p.external_id),
			p.user_id
		)::text`;

		const authorFilter =
			authors.length > 0
				? Prisma.sql`AND (${Prisma.join(
						authors.map(
							(author) =>
								Prisma.sql`strpos(lower(COALESCE(t.author_username, t.username, '')), ${author}) > 0`,
						),
						" OR ",
					)})`
				: Prisma.empty;

		const authorScore =
			authors.length > 0
				? Prisma.sql`GREATEST(${Prisma.join(
						authors.map(
							(author) =>
								Prisma.sql`CASE
									WHEN lower(COALESCE(t.author_username, t.username, '')) = ${author} THEN 1.0
									WHEN strpos(lower(COALESCE(t.author_username, t.username, '')), ${author}) = 1 THEN 0.88
									WHEN strpos(lower(COALESCE(t.author_username, t.username, '')), ${author}) > 0 THEN 0.76
									ELSE 0.0
								END`,
						),
						", ",
					)})`
				: Prisma.sql`0.0`;

		const lexicalMatch = hasTextQuery
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

		const characterScore = hasTextQuery
			? Prisma.sql`
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
			`
			: Prisma.sql`0.0`;

		const tagLexicalScore = hasTextQuery
			? Prisma.sql`
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
			`
			: Prisma.sql`0.0`;

		const postTagScore = hasTextQuery
			? Prisma.sql`
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
				)
			`
			: Prisma.sql`0.0`;

		const postTextScore = hasTextQuery
			? Prisma.sql`GREATEST(
				CASE WHEN lower(COALESCE(t.text, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END,
				CASE WHEN lower(COALESCE(t.title, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END,
				CASE WHEN lower(COALESCE(t.author_name, '')) LIKE ${queryContains} THEN 0.3 ELSE 0.0 END,
				CASE WHEN lower(COALESCE(t.author_username, '')) LIKE ${queryContains} THEN 0.3 ELSE 0.0 END
			)`
			: Prisma.sql`0.0`;

		let rankedPhotos: InlineImageSearchResult[] = [];

		if (userId) {
			if (!hasTextQuery) {
				const recencyAuthorFilter =
					authors.length > 0
						? Prisma.sql`AND (${Prisma.join(
								authors.map(
									(author) =>
										Prisma.sql`strpos(lower(COALESCE(t.author_username, t.username, '')), ${author}) > 0`,
								),
								" OR ",
							)})`
						: Prisma.empty;

				rankedPhotos = await runInlineImageQuery(
					ctx.logger,
					{ searchMode: "recency", userId, photoOffset, pageQueryLimit },
					() =>
						prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
					WITH ranked AS (
						SELECT
							p.external_id AS photo_id,
							p.provider AS photo_provider,
							p.user_id AS photo_user_id,
							p.s3_path,
							t.external_id AS tweet_id,
							t.source_url,
							COALESCE(t.author_username, t.username) AS username,
							p.height,
							p.width,
							p.created_at AS photo_created_at,
							ROW_NUMBER() OVER (
								PARTITION BY ${photoDedupeKey}
								ORDER BY p.created_at DESC, p.provider DESC, p.external_id DESC, p.user_id DESC
							) AS duplicate_rank
						FROM media p
						JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.kind = 'image'
							AND p.s3_path IS NOT NULL
							${recencyAuthorFilter}
					)
					SELECT
						photo_id,
						photo_provider,
						photo_user_id,
						s3_path,
						tweet_id,
						source_url,
						username,
						height,
						width,
						0.0 AS final_score
					FROM ranked
					WHERE duplicate_rank = 1
					ORDER BY photo_created_at DESC, photo_provider DESC, photo_id DESC, photo_user_id DESC
					OFFSET ${photoOffset}
					LIMIT ${pageQueryLimit}
					`),
				);
			} else {
				let textEmbedding: number[] | null = null;
				let shouldUseLegacyQuery = false;

				if (hasTextQuery) {
					try {
						textEmbedding = await getInlineQueryEmbedding(textQuery);
					} catch (error) {
						ctx.logger.warn(
							{ error, query: textQuery },
							"Inline image semantic search unavailable",
						);
					}

					if (!textEmbedding) {
						shouldUseLegacyQuery = true;
					}
				}

				if (shouldUseLegacyQuery) {
					rankedPhotos = await searchInlineImagesWithLegacyQuery(
						ctx.logger,
						userId,
						query,
						photoOffset,
						pageQueryLimit,
					);
				} else if (textEmbedding) {
					const textVector = `[${textEmbedding.join(",")}]`;

					rankedPhotos = await runInlineImageQuery(
						ctx.logger,
						{ searchMode: "semantic", userId, photoOffset, pageQueryLimit, candidateLimit },
						() =>
							prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
					WITH image_candidates AS (
						SELECT p.external_id AS id, p.user_id, p.provider
						FROM media p
						JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.kind = 'image'
							AND p.s3_path IS NOT NULL
							AND p.classification IS NOT NULL
							AND p.image_vec IS NOT NULL
							AND p.tag_vec IS NOT NULL
							${authorFilter}
						ORDER BY p.image_vec <=> ${textVector}::vector, p.provider DESC, p.external_id DESC, p.user_id DESC
						LIMIT ${candidateLimit}
					),
					tag_candidates AS (
						SELECT p.external_id AS id, p.user_id, p.provider
						FROM media p
						JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.kind = 'image'
							AND p.s3_path IS NOT NULL
							AND p.classification IS NOT NULL
							AND p.image_vec IS NOT NULL
							AND p.tag_vec IS NOT NULL
							${authorFilter}
						ORDER BY p.tag_vec <=> ${textVector}::vector, p.provider DESC, p.external_id DESC, p.user_id DESC
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
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.kind = 'image'
							AND p.s3_path IS NOT NULL
							AND ${lexicalMatch}
							${authorFilter}
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
							p.external_id AS photo_id,
							p.provider AS photo_provider,
							p.user_id AS photo_user_id,
							${photoDedupeKey} AS dedupe_key,
							p.s3_path,
							p.height,
							p.width,
							COALESCE(t.author_username, t.username) AS username,
							t.external_id AS tweet_id,
							t.source_url,
							t.created_at AS tweet_created_at,
							COALESCE(1.0 - (p.image_vec <=> ${textVector}::vector), 0.0) AS s_image,
							COALESCE(1.0 - (p.tag_vec <=> ${textVector}::vector), 0.0) AS s_tag_semantic,
							${characterScore} AS s_character,
							${tagLexicalScore} AS s_tag_lexical,
							${postTagScore} AS s_post_tag,
							${postTextScore} AS s_post_text,
							${authorScore} AS s_author
						FROM candidate_pool c
						JOIN media p ON p.external_id = c.id AND p.user_id = c.user_id AND p.provider = c.provider
						JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
					),
					fused AS (
						SELECT
							photo_id,
							photo_provider,
							photo_user_id,
							dedupe_key,
							s3_path,
							tweet_id,
							source_url,
							username,
							tweet_created_at,
							height,
							width,
							(
								(s_character * 0.4) +
								(GREATEST(s_tag_semantic, s_tag_lexical) * 0.24) +
								(GREATEST(s_post_tag, s_post_text) * 0.12) +
								(s_image * 0.1) +
								(s_author * 0.08) +
								(0.02 * EXP(LN(0.5) * (EXTRACT(EPOCH FROM (${queryTime}::timestamptz - tweet_created_at)) / (180.0 * 24 * 3600.0))))
							) AS final_score
						FROM scored
					),
					deduped AS (
						SELECT
							photo_id,
							photo_provider,
							photo_user_id,
							s3_path,
							tweet_id,
							source_url,
							username,
							height,
							width,
							final_score,
							ROW_NUMBER() OVER (
								PARTITION BY dedupe_key
								ORDER BY final_score DESC NULLS LAST, tweet_created_at DESC, photo_provider DESC, photo_id DESC, photo_user_id DESC
							) AS duplicate_rank
						FROM fused
					)
					SELECT photo_id, photo_provider, photo_user_id, s3_path, tweet_id, source_url, username, height, width, final_score
					FROM deduped
					WHERE duplicate_rank = 1
					ORDER BY final_score DESC NULLS LAST, photo_provider DESC, photo_id DESC, photo_user_id DESC
					OFFSET ${photoOffset}
					LIMIT ${pageQueryLimit}
						`),
					);
				} else {
					const lexicalFilter = hasTextQuery ? Prisma.sql`AND ${lexicalMatch}` : Prisma.empty;

					rankedPhotos = await runInlineImageQuery(
						ctx.logger,
						{ searchMode: "lexical", userId, photoOffset, pageQueryLimit },
						() =>
							prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
					WITH scored AS (
						SELECT
							p.external_id AS photo_id,
							p.provider AS photo_provider,
							p.user_id AS photo_user_id,
							${photoDedupeKey} AS dedupe_key,
							p.s3_path,
							p.height,
							p.width,
							COALESCE(t.author_username, t.username) AS username,
							t.external_id AS tweet_id,
							t.source_url,
							t.created_at AS tweet_created_at,
							${characterScore} AS s_character,
							${tagLexicalScore} AS s_tag_lexical,
							${postTagScore} AS s_post_tag,
							${postTextScore} AS s_post_text,
							${authorScore} AS s_author
						FROM media p
						JOIN posts t ON t.external_id = p.post_external_id AND t.user_id = p.user_id AND t.provider = p.provider
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.kind = 'image'
							AND p.s3_path IS NOT NULL
							${authorFilter}
							${lexicalFilter}
					),
					fused AS (
						SELECT
							photo_id,
							photo_provider,
							photo_user_id,
							dedupe_key,
							s3_path,
							tweet_id,
							source_url,
							username,
							tweet_created_at,
							height,
							width,
							(
								(s_author * 0.56) +
								(s_character * 0.22) +
								(s_tag_lexical * 0.12) +
								(GREATEST(s_post_tag, s_post_text) * 0.08) +
								(0.02 * EXP(LN(0.5) * (EXTRACT(EPOCH FROM (NOW() - tweet_created_at)) / (180.0 * 24 * 3600.0))))
							) AS final_score
						FROM scored
					),
					deduped AS (
						SELECT
							photo_id,
							photo_provider,
							photo_user_id,
							s3_path,
							tweet_id,
							source_url,
							username,
							height,
							width,
							final_score,
							ROW_NUMBER() OVER (
								PARTITION BY dedupe_key
								ORDER BY final_score DESC NULLS LAST, tweet_created_at DESC, photo_provider DESC, photo_id DESC, photo_user_id DESC
							) AS duplicate_rank
						FROM fused
					)
					SELECT photo_id, photo_provider, photo_user_id, s3_path, tweet_id, source_url, username, height, width, final_score
					FROM deduped
					WHERE duplicate_rank = 1
					ORDER BY final_score DESC NULLS LAST, photo_provider DESC, photo_id DESC, photo_user_id DESC
					OFFSET ${photoOffset}
					LIMIT ${pageQueryLimit}
						`),
					);
				}
			}
		}

		const photosForThisPage = rankedPhotos.slice(0, INLINE_QUERY_PAGE_SIZE);

		if (photosForThisPage.length === 0 && (!ctx.user || !(await hasTwitterCookies(ctx.user.id)))) {
			// User didn't setup the bot yet
			await ctx.answerInlineQuery(
				[
					InlineQueryResultBuilder.article(`id:no-photos:${ctx.from?.id}`, "Oops, no photos...", {
						reply_markup: new InlineKeyboard().url(
							"Set cookies",
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
				? FormattedString.link(`@${photo.username}`, photo.source_url)
				: new FormattedString(photo.source_url);

			return InlineQueryResultBuilder.photo(
				createInlineImageResultId(photo.photo_provider, photo.photo_id, photo.photo_user_id),
				photoUrl,
				{
					caption: caption.caption,
					caption_entities: caption.caption_entities,
					thumbnail_url: photoUrl,
					photo_height: photo.height ?? undefined,
					photo_width: photo.width ?? undefined,
				},
			);
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
	},
);

privateChat.command("cookies", async (ctx) => {
	const connected = ctx.user ? await hasTwitterCookies(ctx.user.id) : false;
	const keyboard = new InlineKeyboard().webApp(connected ? "Manage Twitter" : "Set cookies", {
		url: `${env.BASE_FRONTEND_URL}/settings`,
	});
	const message = connected
		? "Twitter is connected. Use settings to replace or delete your cookies."
		: "No cookies found. Please set your cookies first.";
	await ctx.reply(message, { reply_markup: keyboard });
});

privateChat.command("scrapper", async (ctx) => {
	const user = ctx.user;
	if (!(user && (await hasTwitterCookies(user.id)))) {
		const keyboard = new InlineKeyboard().webApp("Set cookies", {
			url: `${env.BASE_FRONTEND_URL}/cookies`,
		});
		await ctx.reply(
			"Beep boop, you need to give me your cookies before I can send you daily images.",
			{ reply_markup: keyboard },
		);
		return;
	}

	const generation = getScheduledScrapperGeneration();

	const scheduledJob = await scrapperApp.spawn(
		"scheduled-feed-scrapper",
		{
			generation,
			userId: user.id,
			limit: 300,
		},
		{
			idempotencyKey: `scheduled-scrapper-${user.id}-${generation}`,
			maxAttempts: 3,
			retryStrategy: RETRY.scrapper,
		},
	);

	if (scheduledJob.created) {
		ctx.logger.debug({ userId: user.id }, "Scheduled scrapper");

		await scrapperApp.spawn(
			"feed-scrapper",
			{ userId: user.id, count: 0, limit: 300 },
			{
				maxAttempts: 3,
				retryStrategy: RETRY.scrapper,
			},
		);

		await ctx.reply(
			"You placed in the queue (runs every 6 hours). You can check your images in a few minutes in your gallery.\n\nYou can start the job anytime by sending /scrapper command again.",
			{
				reply_markup: webAppKeyboard("app", "View gallery"),
			},
		);
		return;
	}

	await scrapperApp.spawn(
		"feed-scrapper",
		{ userId: user.id, count: 0, limit: 100 },
		{
			maxAttempts: 3,
			retryStrategy: RETRY.scrapper,
		},
	);

	await ctx.reply("Starting to collect images, check back in a few minutes.");
});

export default composer;

import { FormattedString } from "@grammyjs/parse-mode";
import { CookieEncryption } from "@starlight/crypto";
import { env, isTwitterUrl, Prisma, prisma } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import { Composer, InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { webAppKeyboard } from "@/bot";
import { scrapperQueue } from "@/queue/scrapper";
import { Cookies, redis } from "@/storage";
import type { Context } from "@/types";

const INLINE_QUERY_PAGE_SIZE = 50;
const INLINE_QUERY_CANDIDATE_MULTIPLIER = 8;
const INLINE_QUERY_AUTHOR_REGEX = /(^|\s)@([A-Za-z0-9_]+)/g;

type InlineImageSearchResult = {
	photo_id: string;
	s3_path: string;
	tweet_id: string;
	username: string | null;
	height: number | null;
	width: number | null;
	final_score: number;
};

async function searchInlineImagesWithLegacyQuery(
	userId: string,
	query: string,
	photoOffset: number,
	pageQueryLimit: number,
): Promise<InlineImageSearchResult[]> {
	const allPhotos: InlineImageSearchResult[] = [];
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

		const tweets = await prisma.tweet.findMany({
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
		});

		if (tweets.length === 0) {
			break;
		}

		for (const tweet of tweets) {
			for (const photo of tweet.photos) {
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

	const cacheKey = `inline-query:${Bun.hash.xxHash3(query)}`;

	try {
		const cachedEmbedding = await redis.get(cacheKey);

		if (cachedEmbedding) {
			return JSON.parse(cachedEmbedding) as number[];
		}
	} catch {
		// Redis unavailable, proceed without cache
	}

	const response = await http(new URL("/v1/embeddings", env.ML_BASE_URL).toString(), {
		method: "post",
		headers: {
			"Content-Type": "application/json",
			"X-API-Token": env.ML_API_TOKEN,
			"X-Request-Id": Bun.randomUUIDv7(),
		},
		json: {
			tags: query,
			encoding_mode: "retrieval.query",
		},
	});

	if (!response.ok) {
		throw new Error(`Inline image search embeddings failed: ${response.status}`);
	}

	const data = (await response.json()) as {
		text: number[];
	};

	try {
		await redis.setex(cacheKey, 60 * 60 * 24 * 7, JSON.stringify(data.text));
	} catch {
		// Redis unavailable, skip caching
	}

	return data.text;
}

const scrapperRateLimiter = new RateLimiterRedis({
	storeClient: redis,
	points: 1, // 1 parsing schedule per 15 minutes
	duration: 60 * 15, // per 15 minutes
	keyPrefix: "scrapper",
});

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);

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

		const authorFilter =
			authors.length > 0
				? Prisma.sql`AND (${Prisma.join(
						authors.map(
							(author) => Prisma.sql`strpos(lower(COALESCE(t.username, '')), ${author}) > 0`,
						),
						Prisma.sql` OR `,
					)})`
				: Prisma.empty;

		const authorScore =
			authors.length > 0
				? Prisma.sql`GREATEST(${Prisma.join(
						authors.map(
							(author) =>
								Prisma.sql`CASE
									WHEN lower(COALESCE(t.username, '')) = ${author} THEN 1.0
									WHEN strpos(lower(COALESCE(t.username, '')), ${author}) = 1 THEN 0.88
									WHEN strpos(lower(COALESCE(t.username, '')), ${author}) > 0 THEN 0.76
									ELSE 0.0
								END`,
						),
						Prisma.sql`, `,
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

		const hashtagScore = hasTextQuery
			? Prisma.sql`
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
			`
			: Prisma.sql`0.0`;

		const tweetTextScore = hasTextQuery
			? Prisma.sql`CASE WHEN lower(COALESCE(t.tweet_text, '')) LIKE ${queryContains} THEN 0.34 ELSE 0.0 END`
			: Prisma.sql`0.0`;

		let rankedPhotos: InlineImageSearchResult[] = [];

		if (userId) {
			if (!hasTextQuery) {
				const recencyAuthorFilter =
					authors.length > 0
						? Prisma.sql`AND (${Prisma.join(
								authors.map(
									(author) => Prisma.sql`strpos(lower(COALESCE(t.username, '')), ${author}) > 0`,
								),
								Prisma.sql` OR `,
							)})`
						: Prisma.empty;

				rankedPhotos = await prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
					SELECT
						p.id AS photo_id,
						p.s3_path,
						t.id AS tweet_id,
						t.username,
						p.height,
						p.width,
						0.0 AS final_score
					FROM photos p
					JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
					WHERE p.user_id = ${userId}
						AND p.deleted_at IS NULL
						AND p.s3_path IS NOT NULL
						${recencyAuthorFilter}
					ORDER BY p.created_at DESC, photo_id DESC
					OFFSET ${photoOffset}
					LIMIT ${pageQueryLimit}
				`);
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
						userId,
						query,
						photoOffset,
						pageQueryLimit,
					);
				} else if (textEmbedding) {
					const textVector = `[${textEmbedding.join(",")}]`;

					rankedPhotos = await prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
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
							s3_path,
							tweet_id,
							username,
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
					)
					SELECT photo_id, s3_path, tweet_id, username, height, width, final_score
					FROM fused
					ORDER BY final_score DESC NULLS LAST, photo_id DESC
					OFFSET ${photoOffset}
					LIMIT ${pageQueryLimit}
				`);
				} else {
					const lexicalFilter = hasTextQuery ? Prisma.sql`AND ${lexicalMatch}` : Prisma.empty;

					rankedPhotos = await prisma.$queryRaw<InlineImageSearchResult[]>(Prisma.sql`
					WITH scored AS (
						SELECT
							p.id AS photo_id,
							p.s3_path,
							p.height,
							p.width,
							t.username,
							t.id AS tweet_id,
							t.created_at AS tweet_created_at,
							${characterScore} AS s_character,
							${tagLexicalScore} AS s_tag_lexical,
							${hashtagScore} AS s_hashtag,
							${tweetTextScore} AS s_tweet_text,
							${authorScore} AS s_author
						FROM photos p
						JOIN tweets t ON t.id = p.tweet_id AND t.user_id = p.user_id
						WHERE p.user_id = ${userId}
							AND p.deleted_at IS NULL
							AND p.s3_path IS NOT NULL
							${authorFilter}
							${lexicalFilter}
					),
					fused AS (
						SELECT
							photo_id,
							s3_path,
							tweet_id,
							username,
							height,
							width,
							(
								(s_author * 0.56) +
								(s_character * 0.22) +
								(s_tag_lexical * 0.12) +
								(GREATEST(s_hashtag, s_tweet_text) * 0.08) +
								(0.02 * EXP(LN(0.5) * (EXTRACT(EPOCH FROM (NOW() - tweet_created_at)) / (180.0 * 24 * 3600.0))))
							) AS final_score
						FROM scored
					)
					SELECT photo_id, s3_path, tweet_id, username, height, width, final_score
					FROM fused
					ORDER BY final_score DESC NULLS LAST, photo_id DESC
					OFFSET ${photoOffset}
					LIMIT ${pageQueryLimit}
				`);
				}
			}
		}

		const photosForThisPage = rankedPhotos.slice(0, INLINE_QUERY_PAGE_SIZE);

		if (photosForThisPage.length === 0 && !ctx.user?.cookies) {
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
	},
);

privateChat.command("cookies").filter(
	async (ctx) => !ctx.user?.cookies,
	async (ctx) => {
		const keyboard = new InlineKeyboard().webApp("Set cookies", {
			url: `${env.BASE_FRONTEND_URL}/settings`,
		});

		await ctx.reply("No cookies found. Please set your cookies first.", {
			reply_markup: keyboard,
		});
	},
);

privateChat.command("cookies").filter(
	async (ctx) => Boolean(ctx.user?.cookies),
	async (ctx) => {
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
	},
);

privateChat.command("scrapper").filter(
	async (ctx) => !ctx.user?.cookies,
	async (ctx) => {
		const keyboard = new InlineKeyboard().webApp("Set cookies", {
			url: `${env.BASE_FRONTEND_URL}/cookies`,
		});

		await ctx.reply(
			"Beep boop, you need to give me your cookies before I can send you daily images.",
			{ reply_markup: keyboard },
		);
	},
);

privateChat.command("scrapper").filter(
	async (ctx) => Boolean(ctx.user?.cookies),
	async (ctx) => {
		const scheduledJob = await scrapperQueue.getJobScheduler(`scrapper-${ctx.user?.id}`);
		const args = ctx.match;

		if (!scheduledJob) {
			ctx.logger.debug("Upserting job scheduler for user %s", ctx.user?.id);

			await scrapperQueue.upsertJobScheduler(
				`scrapper-${ctx.user?.id}`,
				{
					every: 1000 * 60 * 60 * 6, // 6 hours
				},
				{
					data: {
						userId: ctx.user?.id as string,
						count: 0,
						limit: 300, // 1000 is too much for free users
					},
					name: `scrapper-${ctx.user?.id}`,
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

		if (args !== "safe") {
			try {
				await scrapperRateLimiter.consume(ctx.from.id);
			} catch {
				await ctx.reply(
					"Sorry, but we already collected images for you. You can start a job each 15 minutes only for your convenience to not accidentally block your account.",
				);
				return;
			}
		}

		await scrapperQueue.add(
			"scrapper",
			{
				userId: ctx.user?.id as string,
				count: 0,
				limit: 100,
			},
			{
				deduplication: {
					id: `scrapper-${ctx.user?.id}`,
				},
			},
		);

		await ctx.reply("Starting to collect images, check back in a few minutes.");
	},
);

export default composer;

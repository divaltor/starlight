import { Prisma } from "@starlight/utils";

// Shared by the mini app search router and the bot inline search handler so both rank identically.
export namespace SearchRanking {
  const COSPLAY_QUERY_REGEX = /\bcosplay(?:ers?)?\b/giu;
  const COSPLAY_WEIGHT = 1.5;
  const RECENCY_HALF_LIFE_SECONDS = 90 * 24 * 3600;
  // Larger than any semantic and recency sum, so every lexical match ranks above semantic-only candidates.
  const LEXICAL_TIER = 100;
  // Trigram indexes cannot narrow LIKE patterns shorter than one trigram.
  const MIN_INDEXED_TOKEN_LENGTH = 3;
  const ASCII_REGEX = /^[\u0020-\u007E]+$/u;
  const REGEX_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/gu;

  // Names of one character in several scripts. Only for characters PixAI has no tag for: their posts are
  // reachable only through tweet text and hashtags, which artists often write in Japanese.
  const ALIASES = [["forever young", "フォーエバーヤング"]];

  export type Query = ReturnType<typeof parseQuery>;

  export function parseQuery(query: string) {
    // "miku cosplay" must still match the `hatsune miku` character tag lexically.
    const lexicalQuery = query.replaceAll(COSPLAY_QUERY_REGEX, " ").replaceAll(/\s+/gu, " ").trim();
    const queryLower = lexicalQuery.toLowerCase();
    const compactQuery = queryLower.replaceAll(" ", "");
    const aliases = ALIASES.filter((names) => names.some((name) => compactQuery.includes(name.replaceAll(" ", ""))));

    return {
      cosplayWeight: Number(lexicalQuery !== query) * COSPLAY_WEIGHT,
      patterns: queryLower === "" ? [] : [...new Set([queryLower, ...aliases.flat()])],
      tokens: queryLower.split(" ").filter((token) => token !== ""),
    };
  }

  // Selects photos `p` whose characters, tags, tweet text or hashtags contain a query pattern, with or
  // without spaces, or contain every query word. A superset of what lexicalScore rewards: only plain
  // LIKE keeps the trigram indexes from migration 20261027184818_search_lexical_trigram_indexes usable,
  // and the expressions must match those indexes verbatim or the planner falls back to a full scan.
  export function lexicalMatch(query: Query): Prisma.Sql {
    if (query.patterns.length === 0) {
      return Prisma.sql`FALSE`;
    }

    const likePatterns = [...new Set(query.patterns.flatMap((pattern) => [pattern, pattern.replaceAll(" ", "")]))].map(
      (pattern) => `%${pattern}%`,
    );

    const likeTokens = (query.tokens.length > 1 ? query.tokens : []).flatMap((token) =>
      token.length >= MIN_INDEXED_TOKEN_LENGTH ? [`%${token}%`] : [],
    );

    const contains = (column: Prisma.Sql) => {
      const tokenMatches = likeTokens.map((token) => Prisma.sql`${column} LIKE ${token}`);

      return Prisma.join(
        [
          ...likePatterns.map((pattern) => Prisma.sql`${column} LIKE ${pattern}`),
          ...(tokenMatches.length > 0 ? [Prisma.sql`(${Prisma.join(tokenMatches, " AND ")})`] : []),
        ],
        " OR ",
      );
    };

    return Prisma.sql`(p.id, p.user_id) IN (
			SELECT lp.id, lp.user_id
			FROM photos lp
			WHERE ${contains(Prisma.sql`lower(COALESCE(lp.classification->>'characters', '') || ' ' || COALESCE(lp.classification->>'tags', ''))`)}
			UNION
			SELECT lp.id, lp.user_id
			FROM tweets lt
			JOIN photos lp ON lp.tweet_id = lt.id AND lp.user_id = lt.user_id
			WHERE ${contains(Prisma.sql`lower(COALESCE(lt.tweet_text, '') || ' ' || COALESCE(lt.tweet_data->>'hashtags', ''))`)}
		)`;
  }

  // Scores photo `p` of tweet `t` against the query patterns. Characters, tags and hashtags compare
  // with spaces removed ("fuji masa march" finds `fujimasa march`), tweet text matches the pattern with
  // optional spaces between its letters, and a photo also matches when its characters, tweet text and
  // hashtags contain every query word. General tags stay out of the word match: their unrelated words
  // combine too easily ("school bag" + "uniform").
  export function lexicalScore(query: Query): Prisma.Sql {
    if (query.patterns.length === 0) {
      return Prisma.sql`0.0`;
    }

    const compactPatterns = query.patterns.map((pattern) => pattern.replaceAll(" ", ""));

    const textRegexes = query.patterns.map((pattern) => {
      const body = Array.from(pattern.replaceAll(" ", "").matchAll(/./gu), (match) =>
        match[0].replaceAll(REGEX_SPECIAL_CHARACTERS, String.raw`\$&`),
      ).join(String.raw`\s*`);

      return ASCII_REGEX.test(pattern) ? `(^|[^[:alnum:]_])${body}($|[^[:alnum:]_])` : body;
    });

    const tokenRegexes = query.tokens.map((token) => {
      const body = token.replaceAll(REGEX_SPECIAL_CHARACTERS, String.raw`\$&`);

      return ASCII_REGEX.test(token) ? `(^|[^[:alnum:]_])${body}($|[^[:alnum:]_])` : body;
    });

    return Prisma.sql`GREATEST(
			COALESCE((
				SELECT MAX(CASE
					WHEN character_tag.value = pattern THEN CASE WHEN character_tag.ordinality <= 2 THEN 1.0 ELSE 0.96 END
					WHEN character_tag.value LIKE pattern || '(%' THEN CASE WHEN character_tag.ordinality <= 2 THEN 0.97 ELSE 0.92 END
					WHEN character_tag.value LIKE pattern || '%' THEN CASE WHEN character_tag.ordinality <= 2 THEN 0.92 ELSE 0.86 END
					WHEN character_tag.value LIKE '%' || pattern || '%' THEN CASE WHEN character_tag.ordinality <= 2 THEN 0.82 ELSE 0.76 END
					ELSE 0.0
				END)
				FROM (
					SELECT replace(lower(value), ' ', ''), ordinality
					FROM jsonb_array_elements_text(COALESCE(p.classification->'characters', '[]'::jsonb)) WITH ORDINALITY
				) AS character_tag(value, ordinality)
				CROSS JOIN unnest(${compactPatterns}::text[]) AS pattern
			), 0.0),
			0.8 * COALESCE((
				SELECT MAX(CASE
					WHEN general_tag.value = pattern THEN 0.88
					WHEN general_tag.value LIKE pattern || '%' THEN 0.74
					WHEN general_tag.value LIKE '%' || pattern || '%' THEN 0.58
					ELSE 0.0
				END)
				FROM (
					SELECT replace(lower(value), ' ', '')
					FROM jsonb_array_elements_text(COALESCE(p.classification->'tags', '[]'::jsonb))
				) AS general_tag(value)
				CROSS JOIN unnest(${compactPatterns}::text[]) AS pattern
			), 0.0),
			COALESCE((
				SELECT MAX(CASE
					WHEN hashtag.value = pattern THEN 0.76
					WHEN hashtag.value LIKE pattern || '%' THEN 0.62
					WHEN hashtag.value LIKE '%' || pattern || '%' THEN 0.5
					ELSE 0.0
				END)
				FROM (
					-- chr(12644) is U+3164, an invisible filler some hashtags are padded with.
					SELECT translate(lower(value), ' ' || chr(12644), '')
					FROM jsonb_array_elements_text(COALESCE(t.tweet_data->'hashtags', '[]'::jsonb))
				) AS hashtag(value)
				CROSS JOIN unnest(${compactPatterns}::text[]) AS pattern
			), 0.0),
			CASE WHEN lower(COALESCE(t.tweet_text, '')) ~ ANY (${textRegexes}::text[]) THEN 0.75 ELSE 0.0 END,
			CASE WHEN NOT EXISTS (
				SELECT 1
				FROM unnest(${tokenRegexes}::text[]) AS token
				WHERE lower(COALESCE(p.classification->>'characters', '') || ' ' || COALESCE(t.tweet_text, '') || ' ' || COALESCE(t.tweet_data->>'hashtags', '')) !~ token
			) THEN 0.6 ELSE 0.0 END
		)`;
  }

  // Reads the scored CTE columns s_image, s_tag_semantic, cosplay_score, s_lexical and tweet_created_at.
  // Semantic scores are z-normalised over the candidate pool so image and tag similarities, which sit on
  // different scales, contribute equally.
  export function finalScore(input: { cosplayWeight: number; queryTime: string }) {
    return Prisma.sql`(
			0.5 * COALESCE((s_image - AVG(s_image) OVER ()) / NULLIF(STDDEV_POP(s_image) OVER (), 0), 0) +
			0.5 * COALESCE((s_tag_semantic - AVG(s_tag_semantic) OVER ()) / NULLIF(STDDEV_POP(s_tag_semantic) OVER (), 0), 0) +
			${input.cosplayWeight} * COALESCE((cosplay_score - AVG(cosplay_score) OVER ()) / NULLIF(STDDEV_POP(cosplay_score) OVER (), 0), 0) +
			4.0 * s_lexical +
			CASE WHEN s_lexical > 0 THEN ${LEXICAL_TIER} ELSE 0 END +
			EXP(LN(0.5::float8) * EXTRACT(EPOCH FROM (${input.queryTime}::timestamptz - tweet_created_at))::float8 / ${RECENCY_HALF_LIFE_SECONDS})
		)`;
  }
}

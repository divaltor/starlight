import { Prisma } from "@starlight/utils";

// Shared by the mini app search router and the bot inline search handler so both rank identically.
export namespace SearchRanking {
  const COSPLAY_QUERY_REGEX = /\bcosplay(?:ers?)?\b/giu;
  const COSPLAY_WEIGHT = 1.5;
  const RECENCY_HALF_LIFE_SECONDS = 90 * 24 * 3600;

  export function parseQuery(query: string) {
    // "miku cosplay" must still match the `hatsune miku` character tag lexically.
    const lexicalQuery = query.replaceAll(COSPLAY_QUERY_REGEX, " ").replaceAll(/\s+/gu, " ").trim();

    return { lexicalQuery, cosplayWeight: Number(lexicalQuery !== query) * COSPLAY_WEIGHT };
  }

  // Selects photos `p` whose characters, tags, tweet text or hashtags contain the query. Contains
  // subsumes the equal and prefix checks the scores grade, so one LIKE per text blob selects the same
  // photos. The expressions must match the trigram indexes from migration
  // 20261027184818_search_lexical_trigram_indexes verbatim, or the planner falls back to a full scan.
  export function lexicalMatch(queryContains: string): Prisma.Sql {
    return Prisma.sql`(p.id, p.user_id) IN (
			SELECT lp.id, lp.user_id
			FROM photos lp
			WHERE lower(COALESCE(lp.classification->>'characters', '') || ' ' || COALESCE(lp.classification->>'tags', '')) LIKE ${queryContains}
			UNION
			SELECT lp.id, lp.user_id
			FROM tweets lt
			JOIN photos lp ON lp.tweet_id = lt.id AND lp.user_id = lt.user_id
			WHERE lower(COALESCE(lt.tweet_text, '') || ' ' || COALESCE(lt.tweet_data->>'hashtags', '')) LIKE ${queryContains}
		)`;
  }

  // Reads the scored CTE columns s_image, s_tag_semantic, cosplay_score, s_character, s_tag_lexical,
  // s_hashtag, s_tweet_text and tweet_created_at. Semantic scores are z-normalised over the candidate
  // pool so image and tag similarities, which sit on different scales, contribute equally.
  export function finalScore(input: { cosplayWeight: number; queryTime: string }) {
    return Prisma.sql`(
			0.5 * COALESCE((s_image - AVG(s_image) OVER ()) / NULLIF(STDDEV_POP(s_image) OVER (), 0), 0) +
			0.5 * COALESCE((s_tag_semantic - AVG(s_tag_semantic) OVER ()) / NULLIF(STDDEV_POP(s_tag_semantic) OVER (), 0), 0) +
			${input.cosplayWeight} * COALESCE((cosplay_score - AVG(cosplay_score) OVER ()) / NULLIF(STDDEV_POP(cosplay_score) OVER (), 0), 0) +
			4.0 * GREATEST(s_character, s_tag_lexical * 0.8, s_hashtag * 0.6, s_tweet_text * 0.4) +
			EXP(LN(0.5::float8) * EXTRACT(EPOCH FROM (${input.queryTime}::timestamptz - tweet_created_at))::float8 / ${RECENCY_HALF_LIFE_SECONDS})
		)`;
  }
}

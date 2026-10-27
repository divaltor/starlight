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

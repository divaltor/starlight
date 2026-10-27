-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Trigram indexes for the lexical candidate match in image search (SearchRanking.lexicalMatch).
-- Queries must repeat these expressions verbatim for the planner to use the indexes.
CREATE INDEX IF NOT EXISTS "photos_search_text_trgm_idx" ON "photos" USING gin (
  lower(COALESCE(classification->>'characters', '') || ' ' || COALESCE(classification->>'tags', '')) gin_trgm_ops
);

CREATE INDEX IF NOT EXISTS "tweets_search_text_trgm_idx" ON "tweets" USING gin (
  lower(COALESCE(tweet_text, '') || ' ' || COALESCE(tweet_data->>'hashtags', '')) gin_trgm_ops
);

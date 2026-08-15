-- Generalize the Twitter-shaped media library without replacing existing rows.
ALTER TABLE "tweets" RENAME TO "posts";
ALTER TABLE "posts" RENAME COLUMN "id" TO "external_id";
ALTER TABLE "posts" RENAME COLUMN "tweet_data" TO "provider_payload";
ALTER TABLE "posts" RENAME COLUMN "tweet_text" TO "text";
-- Provider adapters now own canonical text/username fields instead of generated
-- expressions tied to a provider payload shape. Existing generated values remain.
ALTER TABLE "posts" ALTER COLUMN "text" DROP EXPRESSION;
ALTER TABLE "posts" ALTER COLUMN "username" DROP EXPRESSION;
ALTER TABLE "posts" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'twitter';
ALTER TABLE "posts" ADD COLUMN "source_url" TEXT;
ALTER TABLE "posts" ADD COLUMN "author_external_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "author_name" TEXT;
ALTER TABLE "posts" ADD COLUMN "author_username" TEXT;
ALTER TABLE "posts" ADD COLUMN "title" TEXT;
ALTER TABLE "posts" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "posts" SET
  "source_url" = 'https://x.com/i/status/' || "external_id",
  "author_external_id" = "provider_payload"->>'userId',
  "author_name" = "provider_payload"->>'name',
  "author_username" = COALESCE("provider_payload"->>'username', "username"),
  "tags" = CASE
    WHEN jsonb_typeof("provider_payload"->'hashtags') = 'array' THEN ARRAY(
      SELECT btrim(value)
      FROM jsonb_array_elements_text("provider_payload"->'hashtags') WITH ORDINALITY AS hashtag(value, position)
      WHERE btrim(value) <> ''
      GROUP BY btrim(value)
      ORDER BY MIN(position)
    )
    ELSE ARRAY[]::TEXT[]
  END;
ALTER TABLE "posts" ALTER COLUMN "source_url" SET NOT NULL;

ALTER TABLE "photos" RENAME TO "media";
ALTER TABLE "media" RENAME COLUMN "id" TO "external_id";
ALTER TABLE "media" RENAME COLUMN "tweet_id" TO "post_external_id";
ALTER TABLE "media" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'twitter';
ALTER TABLE "media" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'image';
ALTER TABLE "media" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

WITH positions AS (
  SELECT
    "external_id",
    "user_id",
    ROW_NUMBER() OVER (
      PARTITION BY "post_external_id", "user_id"
      ORDER BY "created_at", "external_id"
    ) - 1 AS position
  FROM "media"
)
UPDATE "media" SET "position" = positions.position
FROM positions
WHERE "media"."external_id" = positions."external_id"
  AND "media"."user_id" = positions."user_id";

ALTER TABLE "media" DROP CONSTRAINT "photos_tweet_id_user_id_fkey";
ALTER TABLE "posts" DROP CONSTRAINT "tweets_pkey";
ALTER TABLE "media" DROP CONSTRAINT "photos_pkey";
ALTER TABLE "posts" ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("external_id", "user_id", "provider");
ALTER TABLE "media" ADD CONSTRAINT "media_pkey" PRIMARY KEY ("external_id", "user_id", "provider");
ALTER TABLE "media" ADD CONSTRAINT "media_post_fkey"
  FOREIGN KEY ("post_external_id", "user_id", "provider")
  REFERENCES "posts"("external_id", "user_id", "provider")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "media_post_position_key"
  ON "media"("post_external_id", "user_id", "provider", "position");

ALTER TABLE "users" ADD COLUMN "pixiv_include_private" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "provider_credentials" (
  "user_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "credential_type" TEXT NOT NULL,
  "encrypted_secret" TEXT NOT NULL,
  "external_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("user_id", "provider"),
  CONSTRAINT "provider_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

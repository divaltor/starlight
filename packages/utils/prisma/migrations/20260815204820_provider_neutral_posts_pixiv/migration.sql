-- RenameTable
ALTER TABLE "tweets" RENAME TO "posts";
ALTER TABLE "photos" RENAME TO "media";

-- RenameColumn
ALTER TABLE "posts" RENAME COLUMN "id" TO "external_id";
ALTER TABLE "posts" RENAME COLUMN "tweet_data" TO "provider_payload";
ALTER TABLE "posts" RENAME COLUMN "tweet_text" TO "text";
ALTER TABLE "media" RENAME COLUMN "id" TO "external_id";
ALTER TABLE "media" RENAME COLUMN "tweet_id" TO "post_external_id";

-- AlterTable
ALTER TABLE "users" ADD COLUMN "pixiv_include_private" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "posts"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'twitter',
ADD COLUMN "source_url" TEXT,
ADD COLUMN "author_external_id" TEXT,
ADD COLUMN "author_name" TEXT,
ADD COLUMN "author_username" TEXT,
ADD COLUMN "title" TEXT,
ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "text" DROP EXPRESSION,
ALTER COLUMN "username" DROP EXPRESSION;
ALTER TABLE "media"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'twitter',
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'image',
ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Backfill provider-neutral post fields from the legacy Twitter payload.
UPDATE "posts" SET
  "source_url" = 'https://x.com/i/status/' || "external_id",
  "author_external_id" = "provider_payload"->>'userId',
  "author_name" = "provider_payload"->>'name',
  "author_username" = COALESCE("provider_payload"->>'username', "username");

-- Preserve every legacy media row's order while satisfying the new unique position.
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

ALTER TABLE "posts"
ALTER COLUMN "source_url" SET NOT NULL,
ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "media" ALTER COLUMN "provider" DROP DEFAULT;

-- CreateTable
CREATE TABLE "provider_credentials" (
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "credential_type" TEXT NOT NULL,
    "encrypted_secret" TEXT NOT NULL,
    "external_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("user_id","provider")
);

-- Move legacy Twitter cookies before removing their source column.
INSERT INTO "provider_credentials" (
  "user_id",
  "provider",
  "credential_type",
  "encrypted_secret",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  'twitter',
  'cookies',
  "cookies",
  "created_at",
  "updated_at"
FROM "users"
WHERE "cookies" IS NOT NULL;

ALTER TABLE "users" DROP COLUMN "cookies";

-- ReplacePrimaryKey
ALTER TABLE "media" DROP CONSTRAINT "photos_tweet_id_user_id_fkey";
ALTER TABLE "posts" DROP CONSTRAINT "tweets_pkey";
ALTER TABLE "media" DROP CONSTRAINT "photos_pkey";
ALTER TABLE "posts" ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("external_id", "user_id", "provider");
ALTER TABLE "media" ADD CONSTRAINT "media_pkey" PRIMARY KEY ("external_id", "user_id", "provider");

-- RenameForeignKey
ALTER TABLE "media" RENAME CONSTRAINT "photos_user_id_fkey" TO "media_user_id_fkey";
ALTER TABLE "posts" RENAME CONSTRAINT "tweets_user_id_fkey" TO "posts_user_id_fkey";

-- RenameIndex
ALTER INDEX "photos_created_at_idx" RENAME TO "media_created_at_idx";
ALTER INDEX "photos_deleted_at_idx" RENAME TO "media_deleted_at_idx";
ALTER INDEX "photos_hash_bucket_12_idx" RENAME TO "media_hash_bucket_12_idx";
ALTER INDEX "photos_hash_bucket_4_idx" RENAME TO "media_hash_bucket_4_idx";
ALTER INDEX "photos_hash_bucket_8_idx" RENAME TO "media_hash_bucket_8_idx";
ALTER INDEX "photos_perceptual_hash_idx" RENAME TO "media_perceptual_hash_idx";
ALTER INDEX "photos_s3_path_idx" RENAME TO "media_s3_path_idx";
ALTER INDEX "photos_tweet_id_idx" RENAME TO "media_post_external_id_idx";
ALTER INDEX "tweets_user_id_created_at_idx" RENAME TO "posts_user_id_created_at_idx";
ALTER INDEX "tweets_username_idx" RENAME TO "posts_username_idx";

-- CreateIndex
CREATE UNIQUE INDEX "media_post_external_id_user_id_provider_position_key" ON "media"("post_external_id", "user_id", "provider", "position");

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media" ADD CONSTRAINT "media_post_external_id_user_id_provider_fkey" FOREIGN KEY ("post_external_id", "user_id", "provider") REFERENCES "posts"("external_id", "user_id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE;

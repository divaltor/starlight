-- AlterTable
ALTER TABLE "media" ALTER COLUMN "provider" DROP DEFAULT;

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "text" DROP EXPRESSION,
ALTER COLUMN "username" DROP EXPRESSION,
ALTER COLUMN "provider" DROP DEFAULT;

-- RenameForeignKey
ALTER TABLE "media" RENAME CONSTRAINT "media_post_fkey" TO "media_post_external_id_user_id_provider_fkey";

-- RenameForeignKey
ALTER TABLE "media" RENAME CONSTRAINT "photos_user_id_fkey" TO "media_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "posts" RENAME CONSTRAINT "tweets_user_id_fkey" TO "posts_user_id_fkey";

-- RenameIndex
ALTER INDEX "media_post_position_key" RENAME TO "media_post_external_id_user_id_provider_position_key";

-- RenameIndex
ALTER INDEX "photos_created_at_idx" RENAME TO "media_created_at_idx";

-- RenameIndex
ALTER INDEX "photos_deleted_at_idx" RENAME TO "media_deleted_at_idx";

-- RenameIndex
ALTER INDEX "photos_hash_bucket_12_idx" RENAME TO "media_hash_bucket_12_idx";

-- RenameIndex
ALTER INDEX "photos_hash_bucket_4_idx" RENAME TO "media_hash_bucket_4_idx";

-- RenameIndex
ALTER INDEX "photos_hash_bucket_8_idx" RENAME TO "media_hash_bucket_8_idx";

-- RenameIndex
ALTER INDEX "photos_perceptual_hash_idx" RENAME TO "media_perceptual_hash_idx";

-- RenameIndex
ALTER INDEX "photos_s3_path_idx" RENAME TO "media_s3_path_idx";

-- RenameIndex
ALTER INDEX "photos_tweet_id_idx" RENAME TO "media_post_external_id_idx";

-- RenameIndex
ALTER INDEX "tweets_user_id_created_at_idx" RENAME TO "posts_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "tweets_username_idx" RENAME TO "posts_username_idx";

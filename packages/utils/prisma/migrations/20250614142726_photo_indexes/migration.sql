-- DropIndex
DROP INDEX "tweets_user_id_idx";

-- CreateIndex
CREATE INDEX "photos_s3_path_idx" ON "photos"("s3_path");

-- CreateIndex
CREATE INDEX "photos_deleted_at_idx" ON "photos"("deleted_at");

-- CreateIndex
CREATE INDEX "photos_created_at_idx" ON "photos"("created_at" DESC);

-- CreateIndex
CREATE INDEX "tweets_created_at_idx" ON "tweets"("created_at" DESC);

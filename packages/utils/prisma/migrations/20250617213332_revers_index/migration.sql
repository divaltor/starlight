-- DropIndex
DROP INDEX "tweets_created_at_idx";

-- DropIndex
DROP INDEX "tweets_user_id_created_at_idx";

-- CreateIndex
CREATE INDEX "tweets_created_at_user_id_idx" ON "tweets"("created_at" DESC, "user_id");

-- DropIndex
DROP INDEX "tweets_user_id_idx";

-- CreateIndex
CREATE INDEX "tweets_user_id_created_at_idx" ON "tweets"("user_id", "created_at" DESC);

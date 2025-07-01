-- DropIndex
DROP INDEX "tweets_created_at_user_id_idx";

-- AlterTable
ALTER TABLE "tweets" ADD COLUMN     "tweet_text" TEXT GENERATED ALWAYS AS (tweet_data->>'text') STORED,
ADD COLUMN     "username" TEXT GENERATED ALWAYS AS (tweet_data->>'username') STORED;

-- CreateIndex
CREATE INDEX "tweets_user_id_created_at_idx" ON "tweets"("user_id", "created_at" DESC);

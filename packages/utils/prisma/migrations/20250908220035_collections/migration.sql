-- CreateEnum
CREATE TYPE "CollectionShareVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateTable
CREATE TABLE "profile_shares" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "profile_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_shares" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "visibility" "CollectionShareVisibility" NOT NULL DEFAULT 'PUBLIC',

    CONSTRAINT "collection_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_share_tweets" (
    "id" UUID NOT NULL,
    "collection_share_id" UUID NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "tweet_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_share_tweets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_share_authors" (
    "id" UUID NOT NULL,
    "collection_share_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_share_authors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profile_shares_slug_key" ON "profile_shares"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "profile_shares_user_id_key" ON "profile_shares"("user_id");

-- CreateIndex
CREATE INDEX "profile_shares_slug_idx" ON "profile_shares"("slug");

-- CreateIndex
CREATE INDEX "profile_shares_user_id_idx" ON "profile_shares"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_shares_slug_key" ON "collection_shares"("slug");

-- CreateIndex
CREATE INDEX "collection_shares_slug_idx" ON "collection_shares"("slug");

-- CreateIndex
CREATE INDEX "collection_shares_user_id_idx" ON "collection_shares"("user_id");

-- CreateIndex
CREATE INDEX "collection_share_tweets_collection_share_id_idx" ON "collection_share_tweets"("collection_share_id");

-- CreateIndex
CREATE INDEX "collection_share_tweets_tweet_id_tweet_user_id_idx" ON "collection_share_tweets"("tweet_id", "tweet_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_share_tweets_collection_share_id_tweet_id_tweet__key" ON "collection_share_tweets"("collection_share_id", "tweet_id", "tweet_user_id");

-- CreateIndex
CREATE INDEX "collection_share_authors_collection_share_id_idx" ON "collection_share_authors"("collection_share_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_share_authors_collection_share_id_username_key" ON "collection_share_authors"("collection_share_id", "username");

-- AddForeignKey
ALTER TABLE "profile_shares" ADD CONSTRAINT "profile_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_shares" ADD CONSTRAINT "collection_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_share_tweets" ADD CONSTRAINT "collection_share_tweets_collection_share_id_fkey" FOREIGN KEY ("collection_share_id") REFERENCES "collection_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_share_tweets" ADD CONSTRAINT "collection_share_tweets_tweet_id_tweet_user_id_fkey" FOREIGN KEY ("tweet_id", "tweet_user_id") REFERENCES "tweets"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_share_authors" ADD CONSTRAINT "collection_share_authors_collection_share_id_fkey" FOREIGN KEY ("collection_share_id") REFERENCES "collection_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

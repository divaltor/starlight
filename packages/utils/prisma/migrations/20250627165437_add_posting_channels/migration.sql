-- AlterTable
ALTER TABLE "published_photos" ADD COLUMN     "scheduled_slot_id" UUID;

-- CreateTable
CREATE TABLE "posting_channels" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posting_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_slots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "posting_channel_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_slot_tweets" (
    "id" UUID NOT NULL,
    "scheduled_slot_id" UUID NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_slot_tweets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_slot_photos" (
    "id" UUID NOT NULL,
    "scheduled_slot_tweet_id" UUID NOT NULL,
    "photo_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_slot_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posting_channels_user_id_idx" ON "posting_channels"("user_id");

-- CreateIndex
CREATE INDEX "posting_channels_chat_id_idx" ON "posting_channels"("chat_id");

-- CreateIndex
CREATE INDEX "posting_channels_is_active_idx" ON "posting_channels"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "posting_channels_user_id_chat_id_key" ON "posting_channels"("user_id", "chat_id");

-- CreateIndex
CREATE INDEX "scheduled_slots_user_id_idx" ON "scheduled_slots"("user_id");

-- CreateIndex
CREATE INDEX "scheduled_slots_posting_channel_id_idx" ON "scheduled_slots"("posting_channel_id");

-- CreateIndex
CREATE INDEX "scheduled_slots_scheduled_for_idx" ON "scheduled_slots"("scheduled_for");

-- CreateIndex
CREATE INDEX "scheduled_slots_status_idx" ON "scheduled_slots"("status");

-- CreateIndex
CREATE INDEX "scheduled_slots_created_at_idx" ON "scheduled_slots"("created_at" DESC);

-- CreateIndex
CREATE INDEX "scheduled_slot_tweets_scheduled_slot_id_idx" ON "scheduled_slot_tweets"("scheduled_slot_id");

-- CreateIndex
CREATE INDEX "scheduled_slot_tweets_tweet_id_user_id_idx" ON "scheduled_slot_tweets"("tweet_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_slot_tweets_scheduled_slot_id_tweet_id_user_id_key" ON "scheduled_slot_tweets"("scheduled_slot_id", "tweet_id", "user_id");

-- CreateIndex
CREATE INDEX "scheduled_slot_photos_scheduled_slot_tweet_id_idx" ON "scheduled_slot_photos"("scheduled_slot_tweet_id");

-- CreateIndex
CREATE INDEX "scheduled_slot_photos_photo_id_user_id_idx" ON "scheduled_slot_photos"("photo_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_slot_photos_scheduled_slot_tweet_id_photo_id_user_key" ON "scheduled_slot_photos"("scheduled_slot_tweet_id", "photo_id", "user_id");

-- CreateIndex
CREATE INDEX "published_photos_scheduled_slot_id_idx" ON "published_photos"("scheduled_slot_id");

-- AddForeignKey
ALTER TABLE "posting_channels" ADD CONSTRAINT "posting_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_channels" ADD CONSTRAINT "posting_channels_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_photos" ADD CONSTRAINT "published_photos_scheduled_slot_id_fkey" FOREIGN KEY ("scheduled_slot_id") REFERENCES "scheduled_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_slots" ADD CONSTRAINT "scheduled_slots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_slots" ADD CONSTRAINT "scheduled_slots_posting_channel_id_fkey" FOREIGN KEY ("posting_channel_id") REFERENCES "posting_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_slot_tweets" ADD CONSTRAINT "scheduled_slot_tweets_scheduled_slot_id_fkey" FOREIGN KEY ("scheduled_slot_id") REFERENCES "scheduled_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_slot_tweets" ADD CONSTRAINT "scheduled_slot_tweets_tweet_id_user_id_fkey" FOREIGN KEY ("tweet_id", "user_id") REFERENCES "tweets"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_slot_photos" ADD CONSTRAINT "scheduled_slot_photos_scheduled_slot_tweet_id_fkey" FOREIGN KEY ("scheduled_slot_tweet_id") REFERENCES "scheduled_slot_tweets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_slot_photos" ADD CONSTRAINT "scheduled_slot_photos_photo_id_user_id_fkey" FOREIGN KEY ("photo_id", "user_id") REFERENCES "photos"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

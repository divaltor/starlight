-- DropIndex
DROP INDEX "public"."photos_image_vec_idx";

-- DropIndex
DROP INDEX "public"."photos_tag_vec_idx";

-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "tweet_text" TEXT,
    "telegram_file_id" TEXT NOT NULL,
    "telegram_file_unique_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "videos_user_id_idx" ON "videos"("user_id");

-- CreateIndex
CREATE INDEX "videos_tweet_id_idx" ON "videos"("tweet_id");

-- CreateIndex
CREATE UNIQUE INDEX "videos_telegram_file_unique_id_user_id_key" ON "videos"("telegram_file_unique_id", "user_id");

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

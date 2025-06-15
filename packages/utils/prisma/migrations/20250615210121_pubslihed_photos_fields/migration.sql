/*
  Warnings:

  - Added the required column `message_id` to the `published_photos` table without a default value. This is not possible if the table is not empty.
  - Added the required column `telegram_file_id` to the `published_photos` table without a default value. This is not possible if the table is not empty.
  - Added the required column `telegram_file_unique_id` to the `published_photos` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "published_photos" ADD COLUMN     "media_group_id" TEXT,
ADD COLUMN     "message_id" BIGINT NOT NULL,
ADD COLUMN     "telegram_file_id" TEXT NOT NULL,
ADD COLUMN     "telegram_file_unique_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "published_photos_message_id_idx" ON "published_photos"("message_id");

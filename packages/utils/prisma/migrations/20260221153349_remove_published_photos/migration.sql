/*
  Warnings:

  - You are about to drop the `posting_channels` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `published_photos` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "posting_channels" DROP CONSTRAINT "posting_channels_chat_id_fkey";

-- DropForeignKey
ALTER TABLE "posting_channels" DROP CONSTRAINT "posting_channels_user_id_fkey";

-- DropForeignKey
ALTER TABLE "published_photos" DROP CONSTRAINT "published_photos_chat_id_fkey";

-- DropForeignKey
ALTER TABLE "published_photos" DROP CONSTRAINT "published_photos_photo_id_user_id_fkey";

-- DropForeignKey
ALTER TABLE "published_photos" DROP CONSTRAINT "published_photos_user_id_fkey";

-- DropTable
DROP TABLE "posting_channels";

-- DropTable
DROP TABLE "published_photos";

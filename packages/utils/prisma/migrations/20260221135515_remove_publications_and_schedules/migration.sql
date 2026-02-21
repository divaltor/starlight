/*
  Warnings:

  - You are about to drop the column `scheduled_slot_id` on the `published_photos` table. All the data in the column will be lost.
  - You are about to drop the `collection_share_authors` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `collection_share_tweets` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `collection_shares` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `scheduled_slot_photos` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `scheduled_slot_tweets` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `scheduled_slots` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "collection_share_authors" DROP CONSTRAINT "collection_share_authors_collection_share_id_fkey";

-- DropForeignKey
ALTER TABLE "collection_share_tweets" DROP CONSTRAINT "collection_share_tweets_collection_share_id_fkey";

-- DropForeignKey
ALTER TABLE "collection_share_tweets" DROP CONSTRAINT "collection_share_tweets_tweet_id_tweet_user_id_fkey";

-- DropForeignKey
ALTER TABLE "collection_shares" DROP CONSTRAINT "collection_shares_user_id_fkey";

-- DropForeignKey
ALTER TABLE "published_photos" DROP CONSTRAINT "published_photos_scheduled_slot_id_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_slot_photos" DROP CONSTRAINT "scheduled_slot_photos_photo_id_user_id_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_slot_photos" DROP CONSTRAINT "scheduled_slot_photos_scheduled_slot_tweet_id_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_slot_tweets" DROP CONSTRAINT "scheduled_slot_tweets_scheduled_slot_id_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_slot_tweets" DROP CONSTRAINT "scheduled_slot_tweets_tweet_id_user_id_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_slots" DROP CONSTRAINT "posting_channel";

-- DropForeignKey
ALTER TABLE "scheduled_slots" DROP CONSTRAINT "scheduled_slots_user_id_fkey";

-- DropIndex
DROP INDEX "published_photos_scheduled_slot_id_idx";

-- AlterTable
ALTER TABLE "published_photos" DROP COLUMN "scheduled_slot_id";

-- DropTable
DROP TABLE "collection_share_authors";

-- DropTable
DROP TABLE "collection_share_tweets";

-- DropTable
DROP TABLE "collection_shares";

-- DropTable
DROP TABLE "scheduled_slot_photos";

-- DropTable
DROP TABLE "scheduled_slot_tweets";

-- DropTable
DROP TABLE "scheduled_slots";

-- DropEnum
DROP TYPE "CollectionShareVisibility";

-- DropEnum
DROP TYPE "ScheduledSlotStatus";

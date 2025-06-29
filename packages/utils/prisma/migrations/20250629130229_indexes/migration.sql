/*
  Warnings:

  - The primary key for the `posting_channels` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `description` on the `posting_channels` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `posting_channels` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `posting_channels` table. All the data in the column will be lost.
  - You are about to drop the column `posting_channel_id` on the `scheduled_slots` table. All the data in the column will be lost.
  - Added the required column `chat_id` to the `scheduled_slots` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "scheduled_slots" DROP CONSTRAINT "scheduled_slots_posting_channel_id_fkey";

-- DropIndex
DROP INDEX "scheduled_slots_posting_channel_id_idx";

-- AlterTable
ALTER TABLE "posting_channels" DROP CONSTRAINT "posting_channels_pkey",
DROP COLUMN "description",
DROP COLUMN "id",
DROP COLUMN "name";

-- AlterTable
ALTER TABLE "scheduled_slots" DROP COLUMN "posting_channel_id",
ADD COLUMN     "chat_id" BIGINT NOT NULL;

-- CreateIndex
CREATE INDEX "scheduled_slots_chat_id_idx" ON "scheduled_slots"("chat_id");

-- AddForeignKey
ALTER TABLE "scheduled_slots" ADD CONSTRAINT "scheduled_slots_user_id_chat_id_fkey" FOREIGN KEY ("user_id", "chat_id") REFERENCES "posting_channels"("user_id", "chat_id") ON DELETE RESTRICT ON UPDATE CASCADE;

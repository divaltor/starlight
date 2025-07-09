/*
  Warnings:

  - You are about to drop the column `is_active` on the `posting_channels` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "scheduled_slots" DROP CONSTRAINT "posting_channel";

-- DropIndex
DROP INDEX "posting_channels_is_active_idx";

-- AlterTable
ALTER TABLE "posting_channels" DROP COLUMN "is_active";

-- AddForeignKey
ALTER TABLE "scheduled_slots" ADD CONSTRAINT "posting_channel" FOREIGN KEY ("user_id") REFERENCES "posting_channels"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

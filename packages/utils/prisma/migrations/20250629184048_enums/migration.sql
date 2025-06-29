/*
  Warnings:

  - The `status` column on the `scheduled_slots` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "ScheduledSlotStatus" AS ENUM ('WAITING', 'PUBLISHED');

-- AlterTable
ALTER TABLE "scheduled_slots" DROP COLUMN "status",
ADD COLUMN     "status" "ScheduledSlotStatus" NOT NULL DEFAULT 'WAITING';

-- CreateIndex
CREATE INDEX "scheduled_slots_status_idx" ON "scheduled_slots"("status");

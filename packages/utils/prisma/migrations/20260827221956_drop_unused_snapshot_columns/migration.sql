/*
  Warnings:

  - You are about to drop the column `profile_refreshed_at` on the `memory_profile_snapshots` table. All the data in the column will be lost.
  - You are about to drop the column `source_watermark` on the `memory_profile_snapshots` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "memory_profile_snapshots_invalidated_at_updated_at_idx";

-- AlterTable
ALTER TABLE "memory_profile_snapshots" DROP COLUMN "profile_refreshed_at",
DROP COLUMN "source_watermark";

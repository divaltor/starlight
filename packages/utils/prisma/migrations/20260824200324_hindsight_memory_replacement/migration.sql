/*
  Warnings:

  - You are about to drop the column `latest_revision_id` on the `memory_namespaces` table. All the data in the column will be lost.
  - You are about to drop the column `confidence` on the `memory_observations` table. All the data in the column will be lost.
  - You are about to drop the column `processed_revision_id` on the `memory_observations` table. All the data in the column will be lost.
  - You are about to drop the column `sensitive` on the `memory_observations` table. All the data in the column will be lost.
  - You are about to drop the `memory_build_attempts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `memory_revisions` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "memory_build_attempts" DROP CONSTRAINT "memory_build_attempts_namespace_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_namespaces" DROP CONSTRAINT "memory_namespaces_latest_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_observations" DROP CONSTRAINT "memory_observations_processed_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_revisions" DROP CONSTRAINT "memory_revisions_namespace_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_revisions" DROP CONSTRAINT "memory_revisions_parent_revision_id_fkey";

-- DropIndex
DROP INDEX "memory_namespaces_latest_revision_id_key";

-- DropIndex
DROP INDEX "memory_observations_namespace_id_processed_revision_id_id_idx";

-- AlterTable
ALTER TABLE "memory_namespaces" DROP COLUMN "latest_revision_id";

-- AlterTable
ALTER TABLE "memory_observations" DROP COLUMN "confidence",
DROP COLUMN "processed_revision_id",
DROP COLUMN "sensitive";

-- DropTable
DROP TABLE "memory_build_attempts";

-- DropTable
DROP TABLE "memory_revisions";

-- DropEnum
DROP TYPE "MemoryBuildStatus";

-- CreateIndex
CREATE INDEX "memory_observations_namespace_id_id_idx" ON "memory_observations"("namespace_id", "id");

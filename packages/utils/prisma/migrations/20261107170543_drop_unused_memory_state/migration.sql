/*
  Warnings:

  - You are about to drop the `chat_memory_cursors` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `chat_memory_notes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `memory_profile_snapshots` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "chat_memory_cursors" DROP CONSTRAINT "chat_memory_cursors_chat_id_fkey";

-- DropForeignKey
ALTER TABLE "chat_memory_notes" DROP CONSTRAINT "chat_memory_notes_chat_id_fkey";

-- DropTable
DROP TABLE "chat_memory_cursors";

-- DropTable
DROP TABLE "chat_memory_notes";

-- DropTable
DROP TABLE "memory_profile_snapshots";

-- DropEnum
DROP TYPE "ChatMemoryScope";

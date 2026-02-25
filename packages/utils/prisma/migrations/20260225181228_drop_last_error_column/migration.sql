/*
  Warnings:

  - You are about to drop the column `last_error` on the `chat_memory_cursors` table. All the data in the column will be lost.
  - You are about to drop the column `last_error_at` on the `chat_memory_cursors` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "chat_memory_cursors" DROP COLUMN "last_error",
DROP COLUMN "last_error_at";

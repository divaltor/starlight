/*
  Warnings:

  - You are about to drop the column `model` on the `chat_memory_notes` table. All the data in the column will be lost.
  - You are about to drop the column `prompt_version` on the `chat_memory_notes` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "chat_memory_notes" DROP COLUMN "model",
DROP COLUMN "prompt_version";

/*
  Warnings:

  - The primary key for the `messages` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `messages` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "messages_message_id_chat_id_key";

-- AlterTable
ALTER TABLE "messages" DROP CONSTRAINT "messages_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("message_id", "chat_id");

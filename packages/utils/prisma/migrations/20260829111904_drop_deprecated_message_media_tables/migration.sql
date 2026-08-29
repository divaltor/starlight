/*
  Warnings:

  - You are about to drop the `attachments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `message_parts` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_message_id_chat_id_fkey";

-- DropForeignKey
ALTER TABLE "message_parts" DROP CONSTRAINT "message_parts_message_id_chat_id_fkey";

-- DropTable
DROP TABLE "attachments";

-- DropTable
DROP TABLE "message_parts";

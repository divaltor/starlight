-- AlterTable
ALTER TABLE "chats" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

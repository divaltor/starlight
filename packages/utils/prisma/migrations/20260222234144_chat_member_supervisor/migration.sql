-- AlterTable
ALTER TABLE "chat_members" ADD COLUMN     "supervisor" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "chat_members_chat_id_supervisor_idx" ON "chat_members"("chat_id", "supervisor");

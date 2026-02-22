-- AlterTable
ALTER TABLE "messages"
ADD COLUMN "deleted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "messages_deleted_at_idx" ON "messages"("deleted_at");

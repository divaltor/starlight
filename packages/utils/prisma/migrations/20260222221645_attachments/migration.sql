-- CreateTable
CREATE TABLE "attachments" (
    "id" SERIAL NOT NULL,
    "message_id" INTEGER NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "attachment_type" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "s3_path" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attachments_chat_id_message_id_idx" ON "attachments"("chat_id", "message_id");

-- CreateIndex
CREATE INDEX "attachments_attachment_type_idx" ON "attachments"("attachment_type");

-- CreateIndex
CREATE INDEX "attachments_mime_type_idx" ON "attachments"("mime_type");

-- CreateIndex
CREATE INDEX "attachments_s3_path_idx" ON "attachments"("s3_path");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_chat_id_fkey" FOREIGN KEY ("message_id", "chat_id") REFERENCES "messages"("message_id", "chat_id") ON DELETE CASCADE ON UPDATE CASCADE;

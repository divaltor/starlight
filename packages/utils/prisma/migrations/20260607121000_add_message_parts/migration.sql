-- CreateTable
CREATE TABLE "message_parts" (
    "id" UUID NOT NULL,
    "message_id" INTEGER NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_parts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_parts_message_id_chat_id_idx" ON "message_parts"("message_id", "chat_id");

-- CreateIndex
CREATE INDEX "message_parts_chat_id_type_created_at_idx" ON "message_parts"("chat_id", "type", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "message_parts" ADD CONSTRAINT "message_parts_message_id_chat_id_fkey" FOREIGN KEY ("message_id", "chat_id") REFERENCES "messages"("message_id", "chat_id") ON DELETE CASCADE ON UPDATE CASCADE;

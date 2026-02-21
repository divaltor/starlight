-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "message_id" INTEGER NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "from_id" BIGINT,
    "from_username" TEXT,
    "from_first_name" TEXT,
    "text" TEXT,
    "caption" TEXT,
    "entities" JSONB,
    "caption_entities" JSONB,
    "media_type" TEXT,
    "reply_to_message_id" INTEGER,
    "message_thread_id" INTEGER,
    "forward_origin" JSONB,
    "raw_data" JSONB NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "edit_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_chat_id_date_idx" ON "messages"("chat_id", "date" DESC);

-- CreateIndex
CREATE INDEX "messages_from_id_idx" ON "messages"("from_id");

-- CreateIndex
CREATE INDEX "messages_media_type_idx" ON "messages"("media_type");

-- CreateIndex
CREATE INDEX "messages_text_idx" ON "messages"("text");

-- CreateIndex
CREATE UNIQUE INDEX "messages_message_id_chat_id_key" ON "messages"("message_id", "chat_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

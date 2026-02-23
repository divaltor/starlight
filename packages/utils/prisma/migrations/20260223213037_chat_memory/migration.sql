-- CreateEnum
CREATE TYPE "ChatMemoryScope" AS ENUM ('topic', 'global');

-- CreateTable
CREATE TABLE "chat_memory_cursors" (
    "chat_id" BIGINT NOT NULL,
    "scope" "ChatMemoryScope" NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "last_message_id" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_memory_cursors_pkey" PRIMARY KEY ("chat_id","scope","thread_key")
);

-- CreateTable
CREATE TABLE "chat_memory_notes" (
    "id" UUID NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "scope" "ChatMemoryScope" NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "start_message_id" INTEGER NOT NULL,
    "end_message_id" INTEGER NOT NULL,
    "message_count" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "model" TEXT,
    "prompt_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_memory_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_memory_cursors_chat_id_scope_updated_at_idx" ON "chat_memory_cursors"("chat_id", "scope", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "chat_memory_notes_chat_id_scope_thread_key_created_at_idx" ON "chat_memory_notes"("chat_id", "scope", "thread_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "chat_memory_notes_chat_id_scope_created_at_idx" ON "chat_memory_notes"("chat_id", "scope", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "chat_memory_notes_chat_id_scope_thread_key_end_message_id_key" ON "chat_memory_notes"("chat_id", "scope", "thread_key", "end_message_id");

-- CreateIndex
CREATE INDEX "messages_chat_id_message_thread_id_message_id_idx" ON "messages"("chat_id", "message_thread_id", "message_id");

-- CreateIndex
CREATE INDEX "messages_chat_id_message_id_idx" ON "messages"("chat_id", "message_id");

-- AddForeignKey
ALTER TABLE "chat_memory_cursors" ADD CONSTRAINT "chat_memory_cursors_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_memory_notes" ADD CONSTRAINT "chat_memory_notes_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

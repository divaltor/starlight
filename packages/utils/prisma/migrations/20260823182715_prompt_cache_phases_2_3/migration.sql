-- CreateEnum
CREATE TYPE "ConversationRunStatus" AS ENUM ('prepared', 'invoking', 'generated', 'dispatching', 'finalized', 'failed');

-- CreateEnum
CREATE TYPE "ConversationActionType" AS ENUM ('ignore', 'text', 'reaction');

-- CreateEnum
CREATE TYPE "ConversationDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed', 'unknown');

-- CreateEnum
CREATE TYPE "ConversationToolCallStatus" AS ENUM ('pending', 'running', 'completed', 'error');

-- CreateEnum
CREATE TYPE "ConversationContextStatus" AS ENUM ('active', 'checkpointing', 'sealed', 'superseded', 'invalid');

-- CreateEnum
CREATE TYPE "ConversationTranscriptKind" AS ENUM ('userMessage', 'linkedReplyContext', 'assistantMessage', 'assistantIgnore', 'toolCall', 'toolResult', 'toolError', 'mediaProjection', 'editCorrection', 'systemEvent');

-- CreateEnum
CREATE TYPE "ConversationContextRole" AS ENUM ('system', 'user', 'assistant', 'tool');

-- CreateTable
CREATE TABLE "conversation_lanes" (
    "assistant_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "pending_revision" INTEGER NOT NULL DEFAULT 0,
    "processed_revision" INTEGER NOT NULL DEFAULT 0,
    "active_run_id" UUID,
    "active_context_id" UUID,
    "fencing_token" BIGINT NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_until" TIMESTAMP(3),
    "first_pending_at" TIMESTAMP(3),
    "next_wake_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_lanes_pkey" PRIMARY KEY ("assistant_id","chat_id","thread_key")
);

-- CreateTable
CREATE TABLE "conversation_inputs" (
    "id" BIGSERIAL NOT NULL,
    "assistant_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "source_update_id" INTEGER,
    "source_message_id" INTEGER NOT NULL,
    "source_revision" TEXT NOT NULL,
    "sender_telegram_id" BIGINT,
    "sender_user_id" UUID,
    "payload" JSONB NOT NULL,
    "reply_to_message_id" INTEGER,
    "forward_metadata" JSONB,
    "media_references" JSONB,
    "admitted_revision" INTEGER NOT NULL,
    "claimed_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_wake_outbox" (
    "assistant_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "pending_revision" INTEGER NOT NULL,
    "desired_wake_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_wake_outbox_pkey" PRIMARY KEY ("assistant_id","chat_id","thread_key")
);

-- CreateTable
CREATE TABLE "conversation_runs" (
    "id" UUID NOT NULL,
    "assistant_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "fencing_token" BIGINT NOT NULL,
    "input_start_revision" INTEGER NOT NULL,
    "input_end_revision" INTEGER NOT NULL,
    "status" "ConversationRunStatus" NOT NULL DEFAULT 'prepared',
    "prepared_request" JSONB,
    "request_hash" TEXT,
    "model_profile_fingerprint" TEXT NOT NULL,
    "reply_eligible" BOOLEAN NOT NULL,
    "eligibility_reason" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "generated_output" JSONB,
    "model_transcript" JSONB,
    "usage" JSONB,
    "finish_reason" TEXT,
    "error_tag" TEXT,
    "error_message" TEXT,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoking_at" TIMESTAMP(3),
    "generated_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_run_inputs" (
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "input_id" BIGINT NOT NULL,

    CONSTRAINT "conversation_run_inputs_pkey" PRIMARY KEY ("run_id","ordinal")
);

-- CreateTable
CREATE TABLE "conversation_run_actions" (
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "type" "ConversationActionType" NOT NULL,
    "target_message_id" INTEGER,
    "payload" JSONB NOT NULL,
    "delivery_status" "ConversationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "telegram_message_id" INTEGER,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "unknown_retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_run_actions_pkey" PRIMARY KEY ("run_id","ordinal")
);

-- CreateTable
CREATE TABLE "conversation_tool_calls" (
    "run_id" UUID NOT NULL,
    "provider_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" "ConversationToolCallStatus" NOT NULL,
    "result" JSONB,
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_tool_calls_pkey" PRIMARY KEY ("run_id","provider_call_id")
);

-- CreateTable
CREATE TABLE "conversation_contexts" (
    "id" UUID NOT NULL,
    "assistant_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL,
    "status" "ConversationContextStatus" NOT NULL DEFAULT 'active',
    "active_key" TEXT,
    "parent_context_id" UUID,
    "model_profile_fingerprint" TEXT NOT NULL,
    "stable_envelope" TEXT NOT NULL,
    "stable_envelope_hash" TEXT NOT NULL,
    "frozen_memory" TEXT NOT NULL,
    "frozen_memory_hash" TEXT NOT NULL,
    "base_prefix_hash" TEXT NOT NULL,
    "summary_through_input_sequence" BIGINT,
    "retained_from_turn_ordinal" INTEGER,
    "estimated_stable_tokens" INTEGER NOT NULL DEFAULT 0,
    "last_observed_input_tokens" INTEGER,
    "last_observed_cache_read_tokens" INTEGER,
    "reset_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealed_at" TIMESTAMP(3),

    CONSTRAINT "conversation_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_transcript_turns" (
    "id" BIGSERIAL NOT NULL,
    "assistant_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "ordinal" INTEGER NOT NULL,
    "run_id" UUID NOT NULL,
    "kind" "ConversationTranscriptKind" NOT NULL,
    "content" JSONB NOT NULL,
    "source_references" JSONB NOT NULL,
    "visibility" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_transcript_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_context_turns" (
    "context_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "transcript_turn_id" BIGINT NOT NULL,
    "role" "ConversationContextRole" NOT NULL,
    "rendered_content" TEXT NOT NULL,
    "render_version" TEXT NOT NULL,
    "estimated_tokens" INTEGER NOT NULL,
    "segment_hash" TEXT NOT NULL,
    "rolling_prefix_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_context_turns_pkey" PRIMARY KEY ("context_id","ordinal")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_lanes_active_run_id_key" ON "conversation_lanes"("active_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_lanes_active_context_id_key" ON "conversation_lanes"("active_context_id");

-- CreateIndex
CREATE INDEX "conversation_lanes_next_wake_at_idx" ON "conversation_lanes"("next_wake_at");

-- CreateIndex
CREATE INDEX "conversation_lanes_lease_until_idx" ON "conversation_lanes"("lease_until");

-- CreateIndex
CREATE INDEX "conversation_inputs_claimed_run_id_idx" ON "conversation_inputs"("claimed_run_id");

-- CreateIndex
CREATE INDEX "conversation_inputs_sender_user_id_id_idx" ON "conversation_inputs"("sender_user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_inputs_assistant_id_source_update_id_key" ON "conversation_inputs"("assistant_id", "source_update_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_inputs_assistant_id_chat_id_source_message_id__key" ON "conversation_inputs"("assistant_id", "chat_id", "source_message_id", "source_revision");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_inputs_assistant_id_chat_id_thread_key_admitte_key" ON "conversation_inputs"("assistant_id", "chat_id", "thread_key", "admitted_revision");

-- CreateIndex
CREATE INDEX "conversation_wake_outbox_published_at_desired_wake_at_idx" ON "conversation_wake_outbox"("published_at", "desired_wake_at");

-- CreateIndex
CREATE INDEX "conversation_runs_assistant_id_chat_id_thread_key_status_idx" ON "conversation_runs"("assistant_id", "chat_id", "thread_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_run_inputs_run_id_input_id_key" ON "conversation_run_inputs"("run_id", "input_id");

-- CreateIndex
CREATE INDEX "conversation_run_actions_delivery_status_updated_at_idx" ON "conversation_run_actions"("delivery_status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_contexts_active_key_key" ON "conversation_contexts"("active_key");

-- CreateIndex
CREATE INDEX "conversation_contexts_assistant_id_chat_id_thread_key_statu_idx" ON "conversation_contexts"("assistant_id", "chat_id", "thread_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_contexts_assistant_id_chat_id_thread_key_gener_key" ON "conversation_contexts"("assistant_id", "chat_id", "thread_key", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_transcript_turns_idempotency_key_key" ON "conversation_transcript_turns"("idempotency_key");

-- CreateIndex
CREATE INDEX "conversation_transcript_turns_run_id_idx" ON "conversation_transcript_turns"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_transcript_turns_assistant_id_chat_id_thread_k_key" ON "conversation_transcript_turns"("assistant_id", "chat_id", "thread_key", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_context_turns_context_id_transcript_turn_id_key" ON "conversation_context_turns"("context_id", "transcript_turn_id");

-- AddForeignKey
ALTER TABLE "conversation_inputs" ADD CONSTRAINT "conversation_inputs_assistant_id_chat_id_thread_key_fkey" FOREIGN KEY ("assistant_id", "chat_id", "thread_key") REFERENCES "conversation_lanes"("assistant_id", "chat_id", "thread_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_wake_outbox" ADD CONSTRAINT "conversation_wake_outbox_assistant_id_chat_id_thread_key_fkey" FOREIGN KEY ("assistant_id", "chat_id", "thread_key") REFERENCES "conversation_lanes"("assistant_id", "chat_id", "thread_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_runs" ADD CONSTRAINT "conversation_runs_assistant_id_chat_id_thread_key_fkey" FOREIGN KEY ("assistant_id", "chat_id", "thread_key") REFERENCES "conversation_lanes"("assistant_id", "chat_id", "thread_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_run_inputs" ADD CONSTRAINT "conversation_run_inputs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "conversation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_run_inputs" ADD CONSTRAINT "conversation_run_inputs_input_id_fkey" FOREIGN KEY ("input_id") REFERENCES "conversation_inputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_run_actions" ADD CONSTRAINT "conversation_run_actions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "conversation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tool_calls" ADD CONSTRAINT "conversation_tool_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "conversation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_contexts" ADD CONSTRAINT "conversation_contexts_assistant_id_chat_id_thread_key_fkey" FOREIGN KEY ("assistant_id", "chat_id", "thread_key") REFERENCES "conversation_lanes"("assistant_id", "chat_id", "thread_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_transcript_turns" ADD CONSTRAINT "conversation_transcript_turns_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "conversation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_context_turns" ADD CONSTRAINT "conversation_context_turns_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "conversation_contexts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_context_turns" ADD CONSTRAINT "conversation_context_turns_transcript_turn_id_fkey" FOREIGN KEY ("transcript_turn_id") REFERENCES "conversation_transcript_turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

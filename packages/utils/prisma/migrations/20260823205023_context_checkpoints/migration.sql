/*
  Warnings:

  - A unique constraint covering the columns `[parent_context_id]` on the table `conversation_contexts` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ConversationCheckpointReason" AS ENUM ('softCost', 'hardSafety', 'profileChange', 'manual');

-- CreateEnum
CREATE TYPE "ConversationCheckpointStatus" AS ENUM ('prepared', 'summarizing', 'summarized', 'committed', 'aborted', 'failed');

-- AlterEnum
ALTER TYPE "ConversationContextStatus" ADD VALUE 'retryNeeded';

-- AlterTable
ALTER TABLE "conversation_runs" ADD COLUMN     "context_id" UUID;

-- CreateTable
CREATE TABLE "conversation_checkpoint_attempts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "parent_context_id" UUID NOT NULL,
    "parent_fencing_token" BIGINT NOT NULL,
    "sealed_through_turn_ordinal" INTEGER NOT NULL,
    "head_end_turn_ordinal" INTEGER NOT NULL,
    "retained_start_turn_ordinal" INTEGER,
    "retained_end_turn_ordinal" INTEGER,
    "reason" "ConversationCheckpointReason" NOT NULL,
    "status" "ConversationCheckpointStatus" NOT NULL DEFAULT 'prepared',
    "summary_profile_fingerprint" TEXT NOT NULL,
    "summary_input" TEXT NOT NULL,
    "summary_input_hash" TEXT NOT NULL,
    "summary_output" JSONB,
    "summary_usage" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "child_context_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "conversation_checkpoint_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_checkpoint_attempts_parent_context_id_status_idx" ON "conversation_checkpoint_attempts"("parent_context_id", "status");

-- CreateIndex
CREATE INDEX "conversation_checkpoint_attempts_run_id_status_idx" ON "conversation_checkpoint_attempts"("run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_checkpoint_attempts_parent_context_id_run_id_r_key" ON "conversation_checkpoint_attempts"("parent_context_id", "run_id", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_contexts_parent_context_id_key" ON "conversation_contexts"("parent_context_id");

-- AddForeignKey
ALTER TABLE "conversation_runs" ADD CONSTRAINT "conversation_runs_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "conversation_contexts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_contexts" ADD CONSTRAINT "conversation_contexts_parent_context_id_fkey" FOREIGN KEY ("parent_context_id") REFERENCES "conversation_contexts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_checkpoint_attempts" ADD CONSTRAINT "conversation_checkpoint_attempts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "conversation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_checkpoint_attempts" ADD CONSTRAINT "conversation_checkpoint_attempts_parent_context_id_fkey" FOREIGN KEY ("parent_context_id") REFERENCES "conversation_contexts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

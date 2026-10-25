/*
  Warnings:

  - You are about to drop the column `source_event_sequence` on the `memory_observations` table. All the data in the column will be lost.
  - You are about to drop the column `source_input_id` on the `memory_observations` table. All the data in the column will be lost.
  - You are about to drop the column `source_run_id` on the `memory_observations` table. All the data in the column will be lost.
  - You are about to drop the `conversation_checkpoint_attempts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_context_turns` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_contexts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_inputs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_lanes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_run_actions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_run_inputs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_runs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_tool_calls` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_transcript_turns` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `conversation_wake_outbox` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[namespace_id,source_message_id,source_revision]` on the table `memory_observations` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `source_message_id` to the `memory_observations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source_revision` to the `memory_observations` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "conversation_checkpoint_attempts" DROP CONSTRAINT "conversation_checkpoint_attempts_parent_context_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_checkpoint_attempts" DROP CONSTRAINT "conversation_checkpoint_attempts_run_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_context_turns" DROP CONSTRAINT "conversation_context_turns_context_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_context_turns" DROP CONSTRAINT "conversation_context_turns_transcript_turn_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_contexts" DROP CONSTRAINT "conversation_contexts_assistant_id_chat_id_thread_key_fkey";

-- DropForeignKey
ALTER TABLE "conversation_contexts" DROP CONSTRAINT "conversation_contexts_parent_context_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_inputs" DROP CONSTRAINT "conversation_inputs_assistant_id_chat_id_thread_key_fkey";

-- DropForeignKey
ALTER TABLE "conversation_inputs" DROP CONSTRAINT "conversation_inputs_sender_user_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_run_actions" DROP CONSTRAINT "conversation_run_actions_run_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_run_inputs" DROP CONSTRAINT "conversation_run_inputs_input_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_run_inputs" DROP CONSTRAINT "conversation_run_inputs_run_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_runs" DROP CONSTRAINT "conversation_runs_assistant_id_chat_id_thread_key_fkey";

-- DropForeignKey
ALTER TABLE "conversation_runs" DROP CONSTRAINT "conversation_runs_context_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_tool_calls" DROP CONSTRAINT "conversation_tool_calls_run_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_transcript_turns" DROP CONSTRAINT "conversation_transcript_turns_run_id_fkey";

-- DropForeignKey
ALTER TABLE "conversation_wake_outbox" DROP CONSTRAINT "conversation_wake_outbox_assistant_id_chat_id_thread_key_fkey";

-- DropForeignKey
ALTER TABLE "memory_observations" DROP CONSTRAINT "memory_observations_source_input_id_fkey";

-- DropIndex
DROP INDEX "memory_observations_namespace_id_source_input_id_kind_key";

-- DropIndex
DROP INDEX "memory_observations_source_input_id_idx";

-- DropIndex
DROP INDEX "memory_observations_source_run_id_idx";

-- Backfill the new source columns from the conversation inputs before they are dropped.
ALTER TABLE "memory_observations" ADD COLUMN "source_message_id" INTEGER, ADD COLUMN "source_revision" INTEGER;
UPDATE "memory_observations" o SET "source_message_id" = i."source_message_id", "source_revision" = COALESCE((i."payload"->>'editDate')::int, 0) FROM "conversation_inputs" i WHERE i."id" = o."source_input_id";
DELETE FROM "memory_observations" o USING "memory_observations" d WHERE d."namespace_id" = o."namespace_id" AND d."source_message_id" = o."source_message_id" AND d."source_revision" = o."source_revision" AND d."id" < o."id";

-- AlterTable
ALTER TABLE "memory_observations" DROP COLUMN "source_event_sequence",
DROP COLUMN "source_input_id",
DROP COLUMN "source_run_id",
ALTER COLUMN "source_message_id" SET NOT NULL,
ALTER COLUMN "source_revision" SET NOT NULL;

-- DropTable
DROP TABLE "conversation_checkpoint_attempts";

-- DropTable
DROP TABLE "conversation_context_turns";

-- DropTable
DROP TABLE "conversation_contexts";

-- DropTable
DROP TABLE "conversation_inputs";

-- DropTable
DROP TABLE "conversation_lanes";

-- DropTable
DROP TABLE "conversation_run_actions";

-- DropTable
DROP TABLE "conversation_run_inputs";

-- DropTable
DROP TABLE "conversation_runs";

-- DropTable
DROP TABLE "conversation_tool_calls";

-- DropTable
DROP TABLE "conversation_transcript_turns";

-- DropTable
DROP TABLE "conversation_wake_outbox";

-- DropEnum
DROP TYPE "ConversationActionType";

-- DropEnum
DROP TYPE "ConversationCheckpointReason";

-- DropEnum
DROP TYPE "ConversationCheckpointStatus";

-- DropEnum
DROP TYPE "ConversationContextRole";

-- DropEnum
DROP TYPE "ConversationContextStatus";

-- DropEnum
DROP TYPE "ConversationDeliveryStatus";

-- DropEnum
DROP TYPE "ConversationRunStatus";

-- DropEnum
DROP TYPE "ConversationToolCallStatus";

-- DropEnum
DROP TYPE "ConversationTranscriptKind";

-- CreateIndex
CREATE UNIQUE INDEX "memory_observations_namespace_id_source_message_id_source_r_key" ON "memory_observations"("namespace_id", "source_message_id", "source_revision");

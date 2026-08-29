-- DropIndex
DROP INDEX "attachments_s3_path_idx";

-- DropIndex
DROP INDEX "messages_deleted_at_idx";

-- DropIndex
DROP INDEX "photos_created_at_idx";

-- DropIndex
DROP INDEX "photos_deleted_at_idx";

-- DropIndex
DROP INDEX "photos_perceptual_hash_idx";

-- DropIndex
DROP INDEX "photos_s3_path_idx";

-- DropIndex
DROP INDEX "photos_tweet_id_idx";

-- CreateIndex
CREATE INDEX "conversation_context_turns_transcript_turn_id_idx" ON "conversation_context_turns"("transcript_turn_id");

-- CreateIndex
CREATE INDEX "conversation_run_inputs_input_id_idx" ON "conversation_run_inputs"("input_id");

-- CreateIndex
CREATE INDEX "conversation_runs_context_id_idx" ON "conversation_runs"("context_id");

-- CreateIndex
CREATE INDEX "memory_namespaces_user_id_idx" ON "memory_namespaces"("user_id");

-- CreateIndex
CREATE INDEX "memory_namespaces_chat_id_idx" ON "memory_namespaces"("chat_id");

-- CreateIndex
CREATE INDEX "memory_observations_source_input_id_idx" ON "memory_observations"("source_input_id");

-- CreateIndex
CREATE INDEX "photos_tweet_id_user_id_idx" ON "photos"("tweet_id", "user_id");

-- CreateIndex
CREATE INDEX "photos_user_id_created_at_id_idx" ON "photos"("user_id", "created_at" DESC, "id" DESC);

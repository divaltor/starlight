-- CreateEnum
CREATE TYPE "MemoryNamespaceKind" AS ENUM ('user', 'chat', 'topic');

-- CreateEnum
CREATE TYPE "MemoryObservationKind" AS ENUM ('fact', 'preference', 'correction', 'forget', 'explicitRemember');

-- CreateEnum
CREATE TYPE "MemoryVisibility" AS ENUM ('privateUser', 'sameChat', 'sameTopic', 'publicProfile', 'explicitShareable');

-- CreateEnum
CREATE TYPE "MemoryBuildStatus" AS ENUM ('prepared', 'generating', 'generated', 'published', 'superseded', 'failed');

-- AlterTable
ALTER TABLE "conversation_lanes" ADD COLUMN     "context_reset_pending" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "memory_namespaces" (
    "id" UUID NOT NULL,
    "kind" "MemoryNamespaceKind" NOT NULL,
    "owner_key" TEXT NOT NULL,
    "user_id" UUID,
    "chat_id" BIGINT,
    "thread_key" INTEGER,
    "latest_revision_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_namespaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_observations" (
    "id" BIGSERIAL NOT NULL,
    "namespace_id" UUID NOT NULL,
    "subject_user_id" UUID,
    "source_input_id" BIGINT,
    "source_run_id" UUID,
    "source_event_sequence" BIGINT,
    "source_chat_id" BIGINT NOT NULL,
    "source_thread_key" INTEGER NOT NULL,
    "visibility" "MemoryVisibility" NOT NULL,
    "kind" "MemoryObservationKind" NOT NULL,
    "content" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "processed_revision_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_revisions" (
    "id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "parent_revision_id" UUID,
    "source_through" BIGINT NOT NULL,
    "content" JSONB NOT NULL,
    "schema_version" TEXT NOT NULL,
    "builder_profile_fingerprint" TEXT NOT NULL,
    "usage" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "memory_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_build_attempts" (
    "id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "parent_revision_id" UUID,
    "source_through" BIGINT NOT NULL,
    "frozen_observation_ids" JSONB NOT NULL,
    "status" "MemoryBuildStatus" NOT NULL DEFAULT 'prepared',
    "candidate" JSONB,
    "usage" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "memory_build_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_namespaces_owner_key_key" ON "memory_namespaces"("owner_key");

-- CreateIndex
CREATE UNIQUE INDEX "memory_namespaces_latest_revision_id_key" ON "memory_namespaces"("latest_revision_id");

-- CreateIndex
CREATE INDEX "memory_namespaces_kind_user_id_idx" ON "memory_namespaces"("kind", "user_id");

-- CreateIndex
CREATE INDEX "memory_namespaces_kind_chat_id_thread_key_idx" ON "memory_namespaces"("kind", "chat_id", "thread_key");

-- CreateIndex
CREATE INDEX "memory_observations_namespace_id_processed_revision_id_id_idx" ON "memory_observations"("namespace_id", "processed_revision_id", "id");

-- CreateIndex
CREATE INDEX "memory_observations_subject_user_id_id_idx" ON "memory_observations"("subject_user_id", "id");

-- CreateIndex
CREATE INDEX "memory_observations_source_run_id_idx" ON "memory_observations"("source_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_observations_namespace_id_source_input_id_kind_key" ON "memory_observations"("namespace_id", "source_input_id", "kind");

-- CreateIndex
CREATE INDEX "memory_revisions_namespace_id_source_through_idx" ON "memory_revisions"("namespace_id", "source_through");

-- CreateIndex
CREATE UNIQUE INDEX "memory_revisions_namespace_id_version_key" ON "memory_revisions"("namespace_id", "version");

-- CreateIndex
CREATE INDEX "memory_build_attempts_namespace_id_status_updated_at_idx" ON "memory_build_attempts"("namespace_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_build_attempts_namespace_id_source_through_key" ON "memory_build_attempts"("namespace_id", "source_through");

-- AddForeignKey
ALTER TABLE "conversation_inputs" ADD CONSTRAINT "conversation_inputs_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_namespaces" ADD CONSTRAINT "memory_namespaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_namespaces" ADD CONSTRAINT "memory_namespaces_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_namespaces" ADD CONSTRAINT "memory_namespaces_latest_revision_id_fkey" FOREIGN KEY ("latest_revision_id") REFERENCES "memory_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "memory_namespaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_source_input_id_fkey" FOREIGN KEY ("source_input_id") REFERENCES "conversation_inputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_processed_revision_id_fkey" FOREIGN KEY ("processed_revision_id") REFERENCES "memory_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "memory_namespaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_parent_revision_id_fkey" FOREIGN KEY ("parent_revision_id") REFERENCES "memory_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_build_attempts" ADD CONSTRAINT "memory_build_attempts_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "memory_namespaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

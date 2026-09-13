-- CreateTable
CREATE TABLE "memory_profile_snapshots" (
    "bank_id" TEXT NOT NULL,
    "content" TEXT,
    "profile_refreshed_at" TEXT,
    "source_watermark" TEXT,
    "invalidated_at" TIMESTAMP(3),
    "invalidation_token" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_profile_snapshots_pkey" PRIMARY KEY ("bank_id")
);

-- CreateIndex
CREATE INDEX "memory_profile_snapshots_invalidated_at_updated_at_idx" ON "memory_profile_snapshots"("invalidated_at", "updated_at");

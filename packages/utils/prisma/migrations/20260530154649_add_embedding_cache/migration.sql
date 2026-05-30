-- CreateTable
CREATE TABLE "embedding_cache" (
    "query" BIGINT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "embedding_cache_pkey" PRIMARY KEY ("query")
);

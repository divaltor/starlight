-- AlterTable
ALTER TABLE "photos" 
ADD COLUMN "hash_bucket_4" TEXT GENERATED ALWAYS AS (LEFT("perceptual_hash", 4)) STORED,
ADD COLUMN "hash_bucket_8" TEXT GENERATED ALWAYS AS (LEFT("perceptual_hash", 8)) STORED,
ADD COLUMN "hash_bucket_12" TEXT GENERATED ALWAYS AS (LEFT("perceptual_hash", 12)) STORED;

-- CreateIndex
CREATE INDEX "photos_hash_bucket_4_idx" ON "photos"("hash_bucket_4");

-- CreateIndex
CREATE INDEX "photos_hash_bucket_8_idx" ON "photos"("hash_bucket_8");

-- CreateIndex
CREATE INDEX "photos_hash_bucket_12_idx" ON "photos"("hash_bucket_12");

-- This is an empty migration.
CREATE INDEX IF NOT EXISTS "photos_image_vec_idx" ON "photos" USING hnsw (image_vec vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "photos_tag_vec_idx" ON "photos" USING hnsw (tag_vec vector_cosine_ops);
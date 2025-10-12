-- AlterTable
ALTER TABLE "photos" ADD COLUMN     "caption_text" TEXT,
ADD COLUMN     "caption_vec" vector(512),
ADD COLUMN     "image_vec" vector(512),
ADD COLUMN     "tag_vec" vector(512);

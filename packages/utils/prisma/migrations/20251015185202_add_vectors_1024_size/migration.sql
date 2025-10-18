-- AlterTable
ALTER TABLE "photos" ADD COLUMN     "image_vec" vector(1024),
ADD COLUMN     "tag_vec" vector(1024);

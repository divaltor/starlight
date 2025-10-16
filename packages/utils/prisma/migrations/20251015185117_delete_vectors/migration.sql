/*
  Warnings:

  - You are about to drop the column `caption_text` on the `photos` table. All the data in the column will be lost.
  - You are about to drop the column `caption_vec` on the `photos` table. All the data in the column will be lost.
  - You are about to drop the column `image_vec` on the `photos` table. All the data in the column will be lost.
  - You are about to drop the column `tag_vec` on the `photos` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "photos" DROP COLUMN "caption_text",
DROP COLUMN "caption_vec",
DROP COLUMN "image_vec",
DROP COLUMN "tag_vec";

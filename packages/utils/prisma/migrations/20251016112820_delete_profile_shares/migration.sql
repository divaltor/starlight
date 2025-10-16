/*
  Warnings:

  - You are about to drop the `profile_shares` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."profile_shares" DROP CONSTRAINT "profile_shares_user_id_fkey";

-- DropTable
DROP TABLE "public"."profile_shares";

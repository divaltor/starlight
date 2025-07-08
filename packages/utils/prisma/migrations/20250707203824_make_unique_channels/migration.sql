/*
  Warnings:

  - A unique constraint covering the columns `[user_id]` on the table `posting_channels` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "posting_channels_user_id_key" ON "posting_channels"("user_id");

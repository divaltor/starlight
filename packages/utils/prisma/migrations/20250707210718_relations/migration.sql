-- DropForeignKey
ALTER TABLE "scheduled_slots" DROP CONSTRAINT "scheduled_slots_user_id_chat_id_fkey";

-- DropIndex
DROP INDEX "posting_channels_user_id_chat_id_key";

-- DropIndex
DROP INDEX "scheduled_slots_scheduled_for_idx";

-- AddForeignKey
ALTER TABLE "scheduled_slots" ADD CONSTRAINT "posting_channel" FOREIGN KEY ("user_id") REFERENCES "posting_channels"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

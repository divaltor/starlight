-- AlterTable
ALTER TABLE "conversation_transcript_turns" ADD COLUMN     "source_message_id" INTEGER;


-- Backfill projected Telegram message ids from the JSON contents written before this column existed.
UPDATE "conversation_transcript_turns" SET "source_message_id" = ("content"->>'messageId')::int WHERE "kind" IN ('userMessage', 'editCorrection', 'linkedReplyContext');
UPDATE "conversation_transcript_turns" t SET "source_message_id" = a."telegram_message_id" FROM "conversation_run_actions" a WHERE a."run_id" = t."run_id" AND a."ordinal"::text = t."source_references"->>'actionOrdinal' AND t."kind" IN ('assistantMessage', 'assistantIgnore');

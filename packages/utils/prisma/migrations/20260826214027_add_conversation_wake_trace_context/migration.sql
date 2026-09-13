-- AlterTable
ALTER TABLE "conversation_wake_outbox" ADD COLUMN     "traceparent" TEXT,
ADD COLUMN     "tracestate" TEXT;

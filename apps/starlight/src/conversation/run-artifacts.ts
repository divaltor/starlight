import type { Prisma } from "@starlight/utils/generated/prisma/client";
import { Schema } from "effect";

// Fields the transcript projection reads back from stored inputs.
const ProjectedFields = {
  date: Schema.Int,
  editDate: Schema.NullOr(Schema.Int),
  forwardOrigin: Schema.NullOr(Schema.String),
  messageId: Schema.Int,
  repliedText: Schema.NullOr(Schema.String),
  replyToMessageId: Schema.NullOr(Schema.Int),
  senderFirstName: Schema.String,
  senderId: Schema.NullOr(Schema.Int),
  text: Schema.String,
};

// Reader-side view: validates exactly what projections consume, so input rows written
// before writer-only fields existed still decode.
export const StoredPayloadSchema = Schema.Struct(ProjectedFields);

// The persisted Telegram input written by Conversation.admit. Single owner: both services
// read the same rows, so a second independent definition would drift silently.
export const InputPayloadSchema = Schema.Struct({
  ...ProjectedFields,
  addressed: Schema.Boolean,
  senderIsBot: Schema.optional(Schema.Boolean),
  senderLastName: Schema.optional(Schema.NullOr(Schema.String)),
  senderUsername: Schema.NullOr(Schema.String),
});

export type InputPayload = typeof InputPayloadSchema.Type & Prisma.InputJsonObject;

export const FrozenUserMemorySchema = Schema.Struct({
  text: Schema.String,
  userId: Schema.String,
});
export type FrozenUserMemory = typeof FrozenUserMemorySchema.Type;

// The frozen request written by Conversation.prepareRun and replayed on resume. Only
// values that time erodes are persisted: everything else re-derives deterministically
// from the immutable batch inputs.
export const PreparedRequestSchema = Schema.Struct({
  currentDate: Schema.String,
  sessionId: Schema.String,
  userMemory: Schema.Array(FrozenUserMemorySchema),
});

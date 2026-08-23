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
  senderUsername: Schema.NullOr(Schema.String),
});

export type InputPayload = typeof InputPayloadSchema.Type & Prisma.InputJsonObject;

// The frozen request written by Conversation.prepareRun and replayed on resume.
export const PreparedRequestSchema = Schema.Struct({
  allowedTargetIds: Schema.Array(Schema.Int),
  currentDate: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["assistant", "user"]),
      text: Schema.String,
    }),
  ),
  profileFingerprint: Schema.String,
  replyEligible: Schema.Boolean,
  sessionId: Schema.String,
});

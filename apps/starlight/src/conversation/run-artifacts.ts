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

// One frozen user-memory revision referenced by the request artifact. Memory freezes
// these at prepare time and ConversationContext serializes them back into rendering.
export const FrozenMemoryRevisionSchema = Schema.Struct({
  revisionId: Schema.String,
  userId: Schema.String,
});
export type FrozenMemoryRevision = typeof FrozenMemoryRevisionSchema.Type;

// The frozen request written by Conversation.prepareRun and replayed on resume. Only
// values that time erodes are persisted: everything else re-derives deterministically
// from the immutable batch inputs. Phase 6 extends this artifact with frozen
// memory-revision ids, so it must stay decode-compatible with extra historical fields.
export const PreparedRequestSchema = Schema.Struct({
  currentDate: Schema.String,
  memoryRevisions: Schema.optional(Schema.Array(FrozenMemoryRevisionSchema)),
  sessionId: Schema.String,
});

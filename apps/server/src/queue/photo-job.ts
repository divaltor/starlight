import { Schema } from "effect";

export const PhotoJobData = Schema.Struct({
  photoId: Schema.String,
  requestId: Schema.optional(Schema.String),
  userId: Schema.String,
});
export type PhotoJobData = typeof PhotoJobData.Type;

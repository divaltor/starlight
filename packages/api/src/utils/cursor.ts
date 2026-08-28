import { z } from "zod";

export const CursorPayloadSchema = z.object({
  createdAt: z.iso.datetime(),
  lastTweetId: z.string().min(1),
});

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export const SearchCursorPayloadSchema = z.object({
  lastScore: z.number().finite(),
  lastTweetId: z.string().min(1),
  queryTime: z.iso.datetime(),
});

export type SearchCursorPayload = z.infer<typeof SearchCursorPayloadSchema>;

export const Cursor = {
  create<T = CursorPayload>(data: T): string {
    return Buffer.from(JSON.stringify(data)).toString("base64url");
  },

  parse<T>(cursor: string, schema: z.ZodType<T>): T | null {
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, "base64url").toString();
    } catch {
      return null;
    }

    try {
      const result = schema.safeParse(JSON.parse(decoded));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  },
};

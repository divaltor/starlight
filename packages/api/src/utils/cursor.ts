import { z } from "zod";

export const CursorPayloadSchema = z.object({
  lastPostId: z.string().min(1),
  provider: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export const SearchCursorPayloadSchema = z.object({
  lastScore: z.number().finite(),
  lastProvider: z.string().trim().min(1),
  lastPostId: z.string().trim().min(1),
  lastUserId: z.string().trim().min(1),
  queryTime: z.iso.datetime(),
});

export type SearchCursorPayload = z.infer<typeof SearchCursorPayloadSchema>;

export const isSearchCursorPayload = (value: unknown): value is SearchCursorPayload =>
  SearchCursorPayloadSchema.safeParse(value).success;

export const isAfterSearchCursor = (
  item: { finalScore: number; provider: string; postId: string; userId: string },
  cursor: SearchCursorPayload,
): boolean => {
  if (item.finalScore !== cursor.lastScore) {
    return item.finalScore < cursor.lastScore;
  }
  if (item.provider !== cursor.lastProvider) {
    return item.provider < cursor.lastProvider;
  }
  if (item.postId !== cursor.lastPostId) {
    return item.postId < cursor.lastPostId;
  }
  return item.userId < cursor.lastUserId;
};

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

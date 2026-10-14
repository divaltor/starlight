import { z } from "zod";

const cursorSchema = z.object({ createdAt: z.string(), lastTweetId: z.string() });

export type CursorData = z.infer<typeof cursorSchema>;

export const CursorPagination = {
  createCursor(data: CursorData): string {
    return Buffer.from(JSON.stringify(data)).toString("base64url");
  },

  parseCursor(cursor: string): CursorData | null {
    let decoded: string;

    try {
      decoded = Buffer.from(cursor, "base64url").toString();
    } catch {
      return null;
    }

    try {
      return cursorSchema.safeParse(JSON.parse(decoded)).data ?? null;
    } catch {
      return null;
    }
  },
};

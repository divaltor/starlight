import { expect, test } from "bun:test";
import { Schema } from "effect";
import { PreparedRequestSchema } from "@/conversation/run-artifacts";

test("legacy prepared requests decode with empty user memory", () => {
  expect(
    Schema.decodeUnknownSync(PreparedRequestSchema)({
      currentDate: "2026-08-24",
      memoryRevisions: [{ revisionId: "legacy-revision", userId: "legacy-user" }],
      sessionId: "legacy-session",
    }),
  ).toEqual({
    currentDate: "2026-08-24",
    sessionId: "legacy-session",
    userMemory: [],
  });
});

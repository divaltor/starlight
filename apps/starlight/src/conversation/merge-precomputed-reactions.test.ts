import { expect, test } from "bun:test";
import { Reply } from "@/conversation/reply";

// Our product must keep a precomputed decision-model reaction when the model also replies in the
// same batch, because dropping it silently wastes the decision-model call and loses the acknowledgement.
test("test_mixed_batch_keeps_precomputed_reaction_when_model_also_replies", () => {
  const precomputed = [{ emoji: "👍", messageId: 101, type: "reaction" } as const];
  const generated = [{ replyTo: 103, text: "Hi", type: "text" } as const];

  expect(Reply.mergePrecomputedReactions(precomputed, generated)).toEqual([...precomputed, ...generated]);
});

// Our product must prefer the precomputed decision-model reaction over a model duplicate targeting the
// same message, because Telegram reactions overwrite and the second call is wasted.
test("test_mixed_batch_prefers_precomputed_when_model_duplicates", () => {
  const precomputed = [{ emoji: "👍", messageId: 101, type: "reaction" } as const];

  expect(
    Reply.mergePrecomputedReactions(precomputed, [
      { emoji: "🔥", messageId: 101, type: "reaction" } as const,
      { replyTo: 103, text: "Hi", type: "text" } as const,
    ]),
  ).toEqual([...precomputed, { replyTo: 103, text: "Hi", type: "text" } as const]);
});

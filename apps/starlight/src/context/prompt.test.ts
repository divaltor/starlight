import { expect, test } from "bun:test";
import { Prompt } from "@/context/prompt";

test("appending a finalized turn preserves every prior context segment", () => {
  const envelope = Prompt.renderEnvelope({ toolProfile: ["tool-v1"] });
  const memory = Prompt.renderMemory("");
  const base = new Bun.CryptoHasher("sha256")
    .update(`${envelope.length}:${envelope}${memory.length}:${memory}`)
    .digest("hex");
  const first = Prompt.extendPrefix(base, Prompt.renderTurn({ content: "Alice: hello", role: "user" }));
  const second = Prompt.extendPrefix(
    first.rollingPrefixHash,
    Prompt.renderTurn({ content: "Assistant: hello", role: "assistant" }),
  );

  expect(Prompt.extendPrefix(base, Prompt.renderTurn({ content: "Alice: hello", role: "user" }))).toEqual(first);
  expect(second.rollingPrefixHash).not.toBe(first.rollingPrefixHash);
});

test("the context profile fingerprints the frozen tool envelope", () => {
  expect(Prompt.profileFingerprint(["tool-v1"])).not.toBe(Prompt.profileFingerprint([]));
});

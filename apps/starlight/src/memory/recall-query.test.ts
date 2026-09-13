import { expect, test } from "bun:test";
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { RecallQuery } from "@/memory/recall-query";

test("keeps the complete FIFO recall query when it fits", () => {
  expect(
    RecallQuery.build({
      inputs: [
        { addressed: false, repliedText: null, senderFirstName: "Alice", text: "Earlier context" },
        {
          addressed: true,
          repliedText: "Original question",
          senderFirstName: "Боб",
          text: "Привет 🪶🌿 <|endoftext|>",
        },
      ],
      maxTokens: 800,
    }),
  ).toBe("Alice: Earlier context\nБоб: Привет 🪶🌿 <|endoftext|>\nReplied to: Original question");
});

test("keeps the fallback within the smallest configurable cap", () => {
  expect(RecallQuery.build({ inputs: [], maxTokens: 1 })).toBe("context");
});

test("bounds oversized recall queries while preserving prioritized context in FIFO order", () => {
  const inputs = [
    { addressed: false, repliedText: null, senderFirstName: "Old", text: "obsolete ".repeat(700) },
    { addressed: true, repliedText: "quoted ".repeat(700), senderFirstName: "Alice", text: "addressed 中文 🪶🌿" },
    { addressed: false, repliedText: null, senderFirstName: "Recent", text: "surrounding context" },
  ];
  const query = RecallQuery.build({ inputs, maxTokens: 800 });

  expect(countTokens(query, { disallowedSpecial: new Set<string>() })).toBeLessThanOrEqual(800);
  expect(query).toContain("Old: obsolete");
  expect(query).toContain("Recent: surrounding context");
  expect(query.indexOf("Old:")).toBeLessThan(query.indexOf("Alice:"));
  expect(query.indexOf("Alice:")).toBeLessThan(query.indexOf("Recent:"));
  expect(query).toContain("Alice: addressed 中文 🪶🌿");
  expect(query).toContain("Replied to:");
  expect(query).toContain(" … ");
  expect(RecallQuery.build({ inputs, maxTokens: 800 })).toBe(query);
});

test("honors the configured cap while keeping addressed text before quoted context", () => {
  const query = RecallQuery.build({
    inputs: [
      {
        addressed: true,
        repliedText: `quoted ${"details ".repeat(900)}`,
        senderFirstName: "Alice",
        text: `addressed ${"details ".repeat(900)}`,
      },
    ],
    maxTokens: 80,
  });

  expect(countTokens(query, { disallowedSpecial: new Set<string>() })).toBeLessThanOrEqual(80);
  expect(query).toStartWith("Alice: addressed");
  expect(query).toContain(" … ");
  expect(query).not.toContain("Replied to:");
});

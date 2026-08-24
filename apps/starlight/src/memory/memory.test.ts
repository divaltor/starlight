import { describe, expect, test } from "bun:test";
import { Memory } from "@/memory/memory";

describe("Memory projection", () => {
  test("blocks DM-private facts from group prompts", () => {
    const content = {
      items: [
        {
          confidence: 1,
          content: "private detail",
          sensitive: false,
          sourceChatIds: ["101"],
          sourceObservationIds: ["1"],
          subjectUserIds: ["user-1"],
          visibility: "privateUser" as const,
        },
        {
          confidence: 1,
          content: "same group detail",
          sensitive: false,
          sourceChatIds: ["-200"],
          sourceObservationIds: ["2"],
          subjectUserIds: ["user-1"],
          visibility: "sameChat" as const,
        },
      ],
    };

    expect(Memory.projectItems(content, { assistantId: 1n, chatId: -200n, threadKey: 0 })).toEqual([
      "same group detail",
    ]);
  });

  test("allows attributed group facts in the same user's DM", () => {
    const content = {
      items: [
        {
          confidence: 1,
          content: "group continuity",
          sensitive: false,
          sourceChatIds: ["-200"],
          sourceObservationIds: ["2"],
          subjectUserIds: ["user-1"],
          visibility: "sameChat" as const,
        },
      ],
    };

    expect(Memory.projectItems(content, { assistantId: 1n, chatId: 101n, threadKey: 0 })).toEqual(["group continuity"]);
  });

  test("blocks an item combined from different groups", () => {
    const content = {
      items: [
        {
          confidence: 1,
          content: "combined group detail",
          sensitive: false,
          sourceChatIds: ["-200", "-300"],
          sourceObservationIds: ["2", "3"],
          subjectUserIds: ["user-1"],
          visibility: "sameChat" as const,
        },
      ],
    };

    expect(Memory.projectItems(content, { assistantId: 1n, chatId: -200n, threadKey: 0 })).toEqual([]);
  });
});

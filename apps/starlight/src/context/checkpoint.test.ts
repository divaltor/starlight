import { expect, test } from "bun:test";
import type { ConversationContextRole, ConversationTranscriptKind } from "@starlight/utils/generated/prisma/client";
import { Checkpoint } from "@/context/checkpoint";

test("profile rollover retains at most eight complete recent runs", () => {
  const turns = Array.from({ length: 10 }, (_, index) => sealedTurn(index + 1, `run-${index + 1}`, 100));

  const boundary = Checkpoint.selectProfileBoundary(turns, 6000);

  expect(boundary.head.map((turn) => turn.transcriptTurn.runId)).toEqual(["run-1", "run-2"]);
  expect(boundary.tail.map((turn) => turn.transcriptTurn.runId)).toEqual([
    "run-3",
    "run-4",
    "run-5",
    "run-6",
    "run-7",
    "run-8",
    "run-9",
    "run-10",
  ]);
});

test("profile rollover keeps a contiguous complete tail within its token target", () => {
  const turns = [
    sealedTurn(1, "run-1", 100),
    sealedTurn(2, "run-1", 100),
    sealedTurn(3, "run-2", 200),
    sealedTurn(4, "run-3", 200),
  ];

  const boundary = Checkpoint.selectProfileBoundary(turns, 300);

  expect(boundary.head.map((turn) => turn.transcriptTurn.runId)).toEqual(["run-1", "run-1", "run-2"]);
  expect(boundary.tail.map((turn) => turn.transcriptTurn.runId)).toEqual(["run-3"]);
});

test("profile rollover retains an oversized newest run intact", () => {
  const turns = [sealedTurn(1, "run-1", 100), sealedTurn(2, "run-2", 7000)];

  const boundary = Checkpoint.selectProfileBoundary(turns, 6000);

  expect(boundary.head.map((turn) => turn.transcriptTurn.runId)).toEqual(["run-1"]);
  expect(boundary.tail.map((turn) => turn.transcriptTurn.runId)).toEqual(["run-2"]);
});

test("profile rollover avoids summarizing when recent history fits", () => {
  const turns = [sealedTurn(1, "run-1", 100), sealedTurn(2, "run-2", 100)];

  const boundary = Checkpoint.selectProfileBoundary(turns, 6000);

  expect(boundary.head).toEqual([]);
  expect(boundary.tail).toEqual(turns);
});

function sealedTurn(ordinal: number, runId: string, estimatedTokens: number): Checkpoint.SealedTurn {
  const createdAt = new Date(0);
  return {
    contextId: "context",
    createdAt,
    estimatedTokens,
    ordinal,
    renderedContent: `turn-${ordinal}`,
    renderVersion: "test-v1",
    role: "user" satisfies ConversationContextRole,
    rollingPrefixHash: `rolling-${ordinal}`,
    segmentHash: `segment-${ordinal}`,
    transcriptTurn: {
      assistantId: 1n,
      chatId: 2n,
      content: {},
      createdAt,
      id: BigInt(ordinal),
      idempotencyKey: `${runId}:${ordinal}`,
      kind: "userMessage" satisfies ConversationTranscriptKind,
      ordinal,
      runId,
      sourceMessageId: ordinal,
      sourceReferences: {},
      threadKey: 0,
      visibility: "conversation",
    },
    transcriptTurnId: BigInt(ordinal),
  };
}

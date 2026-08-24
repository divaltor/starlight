import { expect, test } from "bun:test";
import type { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Model } from "@/ai/model";
import { ConversationContext } from "@/context/context";
import { Memory } from "@/memory/memory";
import { Prompt } from "@/context/prompt";
import { Conversation } from "@/conversation/conversation";
import { TelegramDelivery } from "@/conversation/delivery";
import { Database } from "@/services/database";
import { Exa } from "@/services/exa";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)("duplicate Telegram delivery creates one immutable input and one lane revision", async () => {
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!));
  const assistantId = 8_000_000_091;
  const chatId = -8_000_000_091;

  try {
    await runtime.runPromise(
      Effect.gen(function* verifyAdmission() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        const input: Conversation.AdmissionInput = {
          chatTitle: "Phase 2 test",
          chatUsername: null,
          key: { assistantId, chatId, threadKey: 17 },
          payload: {
            addressed: true,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            messageId: 41,
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "@starlight hello",
          },
          updateId: 91,
        };

        const first = yield* conversation.admit(input);
        const duplicate = yield* conversation.admit(input);
        const persisted = yield* database.query(async (client) => {
          const key = {
            assistantId: BigInt(assistantId),
            chatId: BigInt(chatId),
            threadKey: 17,
          };
          return {
            count: await client.conversationInput.count({ where: key }),
            lane: await client.conversationLane.findUniqueOrThrow({
              where: { assistantId_chatId_threadKey: key },
            }),
            outbox: await client.conversationWakeOutbox.findUniqueOrThrow({
              where: { assistantId_chatId_threadKey: key },
            }),
          };
        });

        expect(first.duplicate).toBe(false);
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.inputId).toBe(first.inputId);
        expect(persisted.count).toBe(1);
        expect(persisted.lane.pendingRevision).toBe(1);
        expect(persisted.outbox.pendingRevision).toBe(1);
      }),
    );
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)("unknown delivery retries once without regenerating the model output", async () => {
  const model: Model.Interface = {
    generate: <Output>() =>
      Effect.succeed({
        finishReason: "stop",
        output: { replies: [{ replyTo: 61, text: "Hi", type: "text" }] } as Output,
        steps: [],
        toolEvents: [],
        transcript: [{ text: "Hi", type: "assistant-text" }],
        usage: {
          billing: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            inputTokens: 10,
            outputTokens: 2,
            reasoningTokens: 0,
          },
          contextInputTokens: 10,
          steps: [],
          validForCostThresholds: true,
        },
      }),
  };
  const deliveryResults = [
    Effect.fail(
      new TelegramDelivery.DeliveryError({
        cause: new Error("Telegram timeout"),
        message: "Telegram delivery outcome is unknown",
        outcomeUnknown: true,
        retryable: true,
      }),
    ),
    Effect.fail(
      new TelegramDelivery.DeliveryError({
        cause: new Error("Telegram unavailable"),
        message: "Telegram rejected delivery",
        outcomeUnknown: false,
        retryable: true,
      }),
    ),
    Effect.fail(
      new TelegramDelivery.DeliveryError({
        cause: new Error("Telegram timeout"),
        message: "Telegram delivery outcome is unknown",
        outcomeUnknown: true,
        retryable: true,
      }),
    ),
  ];
  const delivery: TelegramDelivery.Interface = {
    deliver: () => deliveryResults.shift()!,
  };
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, delivery));
  const assistantId = 8_000_000_094;
  const chatId = -8_000_000_094;

  try {
    await runtime.runPromise(
      Effect.gen(function* admit() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        yield* conversation.admit({
          chatTitle: "Phase 2 retry test",
          chatUsername: null,
          key: { assistantId, chatId, threadKey: 0 },
          payload: {
            addressed: true,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            messageId: 61,
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "@starlight hello",
          },
          updateId: 111,
        });
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { nextWakeAt: new Date(0) },
          }),
        );
      }),
    );

    await expect(
      runtime.runPromise(
        Effect.gen(function* firstAttempt() {
          const conversation = yield* Conversation.Service;
          return yield* conversation.drain({
            key: { assistantId, chatId, threadKey: 0 },
          });
        }),
      ),
    ).rejects.toBeInstanceOf(Conversation.ConversationError);
    const resumed = await runtime.runPromise(
      Effect.gen(function* resume() {
        const conversation = yield* Conversation.Service;
        return yield* conversation.drain({
          key: { assistantId, chatId, threadKey: 0 },
        });
      }),
    );
    const persisted = await runtime.runPromise(
      Effect.gen(function* inspect() {
        const database = yield* Database.Service;
        return yield* database.query((client) =>
          client.conversationRun.findFirstOrThrow({
            where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
            include: { actions: true },
          }),
        );
      }),
    );

    expect(resumed.kind).toBe("completed");
    expect(persisted.attemptCount).toBe(1);
    expect(persisted.status).toBe("finalized");
    expect(persisted.actions[0]?.attemptCount).toBe(3);
    expect(persisted.actions[0]?.deliveryStatus).toBe("failed");
    expect(persisted.actions[0]?.unknownRetryCount).toBe(1);
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)(
  "soft checkpoint delivers the crossing reply and retains the newest complete run",
  async () => {
    const requests: Model.GenerateInput<unknown>[] = [];
    const model: Model.Interface = {
      generate: <Output>(input: Model.GenerateInput<Output>) => {
        requests.push(input);
        const output = input.instructions.startsWith("Summarize")
          ? { summary: "Alice asked twice and the assistant answered both messages." }
          : { replies: [{ replyTo: null, text: "Hi", type: "text" }] };
        return Effect.succeed({
          finishReason: "stop",
          output: output as Output,
          steps: [],
          toolEvents: [],
          transcript: [],
          usage: {
            billing: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0,
              inputTokens: 10,
              outputTokens: 2,
              reasoningTokens: 0,
            },
            contextInputTokens: 10,
            steps: [],
            validForCostThresholds: true,
          },
        });
      },
    };
    let telegramMessageId = 900;
    const delivery: TelegramDelivery.Interface = {
      deliver: () => {
        const receipt = { telegramMessageId };
        telegramMessageId += 1;
        return Effect.succeed(receipt);
      },
    };
    const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, delivery, { contextSoftTokenCap: 1 }));
    const assistantId = 8_000_000_096;
    const chatId = -8_000_000_096;
    const key = { assistantId, chatId, threadKey: 0 };

    try {
      await runtime.runPromise(
        Effect.gen(function* runConversation() {
          const conversation = yield* Conversation.Service;
          const database = yield* Database.Service;
          yield* database.query((client) => resetLane(client, assistantId, chatId));
          yield* conversation.admit({
            chatTitle: "Checkpoint test",
            chatUsername: null,
            key,
            payload: {
              addressed: true,
              date: 1_700_000_000,
              editDate: null,
              forwardOrigin: null,
              messageId: 81,
              repliedText: null,
              replyToMessageId: null,
              senderFirstName: "Alice",
              senderId: 42,
              senderUsername: "alice",
              text: "First",
            },
            updateId: 131,
          });
          yield* database.query((client) =>
            client.conversationLane.update({
              where: {
                assistantId_chatId_threadKey: {
                  assistantId: BigInt(assistantId),
                  chatId: BigInt(chatId),
                  threadKey: 0,
                },
              },
              data: { nextWakeAt: new Date(0) },
            }),
          );
          yield* conversation.drain({ key });
          yield* conversation.admit({
            chatTitle: "Checkpoint test",
            chatUsername: null,
            key,
            payload: {
              addressed: true,
              date: 1_700_000_001,
              editDate: null,
              forwardOrigin: null,
              messageId: 82,
              repliedText: null,
              replyToMessageId: null,
              senderFirstName: "Alice",
              senderId: 42,
              senderUsername: "alice",
              text: "Second",
            },
            updateId: 132,
          });
          yield* database.query((client) =>
            client.conversationLane.update({
              where: {
                assistantId_chatId_threadKey: {
                  assistantId: BigInt(assistantId),
                  chatId: BigInt(chatId),
                  threadKey: 0,
                },
              },
              data: { nextWakeAt: new Date(0) },
            }),
          );
          yield* conversation.drain({ key });
        }),
      );

      const state = await runtime.runPromise(
        Effect.gen(function* inspectCheckpoint() {
          const database = yield* Database.Service;
          return yield* database.query(async (client) => ({
            attempts: await client.conversationCheckpointAttempt.findMany({
              where: { parentContext: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) } },
            }),
            contexts: await client.conversationContext.findMany({
              where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
              include: { turns: true },
              orderBy: { generation: "asc" },
            }),
          }));
        }),
      );

      expect(requests).toHaveLength(3);
      expect(requests[1]!.messages.some((message) => message.text.includes("First"))).toBe(true);
      expect(requests[2]!.instructions.startsWith("Summarize")).toBe(true);
      expect(state.contexts.map((context) => context.status)).toEqual(["superseded", "active"]);
      expect(state.contexts[1]!.turns).toHaveLength(2);
      expect(state.attempts).toHaveLength(1);
      expect(state.attempts[0]!.status).toBe("committed");
    } finally {
      await runtime.runPromise(
        Effect.gen(function* cleanup() {
          const database = yield* Database.Service;
          yield* database.query((client) => resetLane(client, assistantId, chatId));
        }),
      );
      await runtime.dispose();
    }
  },
);

test.skipIf(!databaseUrl)("hard checkpoint publishes a child before model invocation", async () => {
  const requests: Model.GenerateInput<unknown>[] = [];
  const model: Model.Interface = {
    generate: <Output>(input: Model.GenerateInput<Output>) => {
      requests.push(input);
      const output = input.instructions.startsWith("Summarize")
        ? { summary: "The recent discussion must remain available." }
        : { replies: [{ replyTo: null, text: "Continued", type: "text" }] };
      return Effect.succeed({
        finishReason: "stop",
        output: output as Output,
        steps: [],
        toolEvents: [],
        transcript: [],
        usage: {
          billing: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            inputTokens: 10,
            outputTokens: 2,
            reasoningTokens: 0,
          },
          contextInputTokens: 10,
          steps: [],
          validForCostThresholds: true,
        },
      });
    },
  };
  const delivery: TelegramDelivery.Interface = {
    deliver: () => Effect.succeed({ telegramMessageId: 901 }),
  };
  const runtime = ManagedRuntime.make(
    testLayer(databaseUrl!, model, delivery, {
      contextEstimateSafetyRatio: 1,
      contextHardTokenCap: 3000,
      contextOutputReserveTokens: 0,
      contextRetainedTokenTarget: 1,
      contextSoftTokenCap: 100_000,
      contextToolReserveTokens: 0,
    }),
  );
  const assistantId = 8_000_000_097;
  const chatId = -8_000_000_097;
  const key = { assistantId, chatId, threadKey: 0 };
  const text = "context ".repeat(250);

  try {
    await runtime.runPromise(
      Effect.gen(function* seedAndRun() {
        const context = yield* ConversationContext.Service;
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        const runIds = yield* database.query(async (client) => {
          await resetLane(client, assistantId, chatId);
          await client.chat.create({ data: { id: BigInt(chatId) } });
          await client.conversationLane.create({
            data: {
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              pendingRevision: 2,
              processedRevision: 2,
              threadKey: 0,
            },
          });
          const firstInput = await client.conversationInput.create({
            data: {
              admittedRevision: 1,
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              payload: {
                addressed: true,
                date: 1_700_000_000,
                editDate: null,
                forwardOrigin: null,
                messageId: 91,
                repliedText: null,
                replyToMessageId: null,
                senderFirstName: "Alice",
                senderId: 42,
                senderUsername: "alice",
                text,
              },
              senderTelegramId: 42n,
              sourceMessageId: 91,
              sourceRevision: "original:91",
              sourceUpdateId: 141,
              threadKey: 0,
            },
          });
          const firstRun = await client.conversationRun.create({
            data: {
              actions: {
                create: {
                  deliveryStatus: "delivered",
                  ordinal: 0,
                  payload: { replyTo: null, text: "First answer", type: "text" },
                  telegramMessageId: 891,
                  type: "text",
                },
              },
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              eligibilityReason: "seed",
              fencingToken: 1n,
              finalizedAt: new Date(),
              inputEndRevision: 1,
              inputStartRevision: 1,
              inputs: { create: { inputId: firstInput.id, ordinal: 0 } },
              modelProfileFingerprint: Prompt.profileFingerprint(false),
              replyEligible: true,
              status: "finalized",
              threadKey: 0,
            },
          });
          const secondInput = await client.conversationInput.create({
            data: {
              admittedRevision: 2,
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              payload: {
                addressed: true,
                date: 1_700_000_001,
                editDate: null,
                forwardOrigin: null,
                messageId: 92,
                repliedText: null,
                replyToMessageId: null,
                senderFirstName: "Alice",
                senderId: 42,
                senderUsername: "alice",
                text,
              },
              senderTelegramId: 42n,
              sourceMessageId: 92,
              sourceRevision: "original:92",
              sourceUpdateId: 142,
              threadKey: 0,
            },
          });
          const secondRun = await client.conversationRun.create({
            data: {
              actions: {
                create: {
                  deliveryStatus: "delivered",
                  ordinal: 0,
                  payload: { replyTo: null, text: "Second answer", type: "text" },
                  telegramMessageId: 892,
                  type: "text",
                },
              },
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              eligibilityReason: "seed",
              fencingToken: 2n,
              finalizedAt: new Date(),
              inputEndRevision: 2,
              inputStartRevision: 2,
              inputs: { create: { inputId: secondInput.id, ordinal: 0 } },
              modelProfileFingerprint: Prompt.profileFingerprint(false),
              replyEligible: true,
              status: "finalized",
              threadKey: 0,
            },
          });
          return { first: firstRun.id, second: secondRun.id };
        });
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { activeRunId: runIds.first, fencingToken: 1n },
          }),
        );
        yield* context.appendFinalized({ fencingToken: 1n, runId: runIds.first });
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { activeRunId: runIds.second, fencingToken: 2n },
          }),
        );
        yield* context.appendFinalized({ fencingToken: 2n, runId: runIds.second });
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { activeRunId: null, fencingToken: 2n },
          }),
        );
        yield* conversation.admit({
          chatTitle: "Hard checkpoint test",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_002,
            editDate: null,
            forwardOrigin: null,
            messageId: 93,
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text,
          },
          updateId: 143,
        });
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { nextWakeAt: new Date(0) },
          }),
        );
        yield* conversation.drain({ key });
      }),
    );

    const state = await runtime.runPromise(
      Effect.gen(function* inspectHardCheckpoint() {
        const database = yield* Database.Service;
        return yield* database.query(async (client) => ({
          attempt: await client.conversationCheckpointAttempt.findFirstOrThrow({
            where: { parentContext: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) } },
          }),
          contexts: await client.conversationContext.findMany({
            where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
            orderBy: { generation: "asc" },
          }),
          latestRun: await client.conversationRun.findFirstOrThrow({
            where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId), inputStartRevision: 3 },
          }),
        }));
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]!.instructions.startsWith("Summarize")).toBe(true);
    expect(requests[1]!.instructions.startsWith("Summarize")).toBe(false);
    expect(state.attempt.reason).toBe("hardSafety");
    expect(state.attempt.status).toBe("committed");
    expect(state.latestRun.contextId).toBe(state.contexts[1]!.id);
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)("an intrinsically oversized request is blocked without model invocation", async () => {
  let modelInvocations = 0;
  const model: Model.Interface = {
    generate: <Output>() => {
      modelInvocations += 1;
      return Effect.succeed({
        finishReason: "stop",
        output: { replies: [{ replyTo: null, text: "Hi", type: "text" }] } as Output,
        steps: [],
        toolEvents: [],
        transcript: [{ text: "Hi", type: "assistant-text" }],
        usage: {
          billing: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            inputTokens: 10,
            outputTokens: 2,
            reasoningTokens: 0,
          },
          contextInputTokens: 10,
          steps: [],
          validForCostThresholds: true,
        },
      });
    },
  };
  const delivery: TelegramDelivery.Interface = {
    deliver: () => Effect.succeed({ telegramMessageId: 950 }),
  };
  const runtime = ManagedRuntime.make(
    testLayer(databaseUrl!, model, delivery, {
      contextEstimateSafetyRatio: 1,
      contextHardTokenCap: 3000,
      contextOutputReserveTokens: 0,
      contextSoftTokenCap: 100_000,
      contextToolReserveTokens: 0,
    }),
  );
  const assistantId = 8_000_000_098;
  const chatId = -8_000_000_098;
  const key = { assistantId, chatId, threadKey: 0 };

  try {
    await runtime.runPromise(
      Effect.gen(function* admitOversized() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        yield* conversation.admit({
          chatTitle: "Oversized test",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_003,
            editDate: null,
            forwardOrigin: null,
            messageId: 94,
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "oversized ".repeat(20_000),
          },
          updateId: 144,
        });
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { nextWakeAt: new Date(0) },
          }),
        );
      }),
    );

    await expect(
      runtime.runPromise(
        Effect.gen(function* firstDrain() {
          const conversation = yield* Conversation.Service;
          return yield* conversation.drain({ key });
        }),
      ),
    ).rejects.toMatchObject({ retryable: false });
    // Regression: blocking must release the lane. Before that, the blocked run stayed
    // activeRunId forever, so every later message re-claimed it and the thread wedged shut.
    const released = await runtime.runPromise(
      Effect.gen(function* drainAfterBlock() {
        const conversation = yield* Conversation.Service;
        return yield* conversation.drain({ key });
      }),
    );
    expect(released.kind).toBe("up-to-date");

    await runtime.runPromise(
      Effect.gen(function* admitAfterBlock() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* conversation.admit({
          chatTitle: "Oversized test",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_004,
            editDate: null,
            forwardOrigin: null,
            messageId: 95,
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "a normal follow-up message must still flow",
          },
          updateId: 145,
        });
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { nextWakeAt: new Date(0) },
          }),
        );
        return yield* conversation.drain({ key });
      }),
    );

    const runs = await runtime.runPromise(
      Effect.gen(function* inspectBlockedRuns() {
        const database = yield* Database.Service;
        return yield* database.query((client) =>
          Promise.all([
            client.conversationRun.findFirstOrThrow({
              where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId), inputStartRevision: 1 },
            }),
            client.conversationRun.findFirstOrThrow({
              where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId), inputStartRevision: 2 },
            }),
            client.conversationLane.findUniqueOrThrow({
              where: {
                assistantId_chatId_threadKey: {
                  assistantId: BigInt(assistantId),
                  chatId: BigInt(chatId),
                  threadKey: 0,
                },
              },
            }),
          ]),
        );
      }),
    );
    const [blockedRun, successorRun, lane] = runs;

    // Exactly one model call: the oversized run must be stopped before invocation,
    // while its normal successor flows through the whole pipeline.
    expect(modelInvocations).toBe(1);
    expect(blockedRun!.status).toBe("blocked");
    expect(blockedRun!.errorTag).toBe("oversized-input");
    expect(successorRun!.status).toBe("finalized");
    expect(lane!.activeRunId).toBeNull();
    expect(lane!.processedRevision).toBe(2);
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)("an edit in the original message second creates a correction revision", async () => {
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!));
  const assistantId = 8_000_000_095;
  const chatId = -8_000_000_095;

  try {
    await runtime.runPromise(
      Effect.gen(function* verifyEditRevision() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        const original: Conversation.AdmissionInput = {
          chatTitle: "Phase 2 edit test",
          chatUsername: null,
          key: { assistantId, chatId, threadKey: 0 },
          payload: {
            addressed: true,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            messageId: 71,
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "Original",
          },
          updateId: 121,
        };
        const edit: Conversation.AdmissionInput = {
          ...original,
          payload: {
            ...original.payload,
            editDate: 1_700_000_000,
            text: "Corrected",
          },
          updateId: 122,
        };

        const admittedOriginal = yield* conversation.admit(original);
        const admittedEdit = yield* conversation.admit(edit);
        const revisions = yield* database.query((client) =>
          client.conversationInput.findMany({
            where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
            orderBy: { admittedRevision: "asc" },
            select: { sourceRevision: true },
          }),
        );

        expect(admittedOriginal.pendingRevision).toBe(1);
        expect(admittedEdit.pendingRevision).toBe(2);
        expect(revisions).toHaveLength(2);
        expect(revisions[0]?.sourceRevision.startsWith("original:")).toBe(true);
        expect(revisions[1]?.sourceRevision.startsWith("edit:")).toBe(true);
      }),
    );
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)("a permanently failing checkpoint blocks the run and releases its lane", async () => {
  let summarizeAttempts = 0;
  const model: Model.Interface = {
    generate: () => {
      summarizeAttempts += 1;
      return Effect.fail(new Model.Unavailable({ message: "provider rejects summaries forever", retryable: false }));
    },
  };
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model));
  const assistantId = 8_000_000_099;
  const chatId = -8_000_000_099;
  const key = { assistantId, chatId, threadKey: 0 };

  try {
    await runtime.runPromise(
      Effect.gen(function* seedFailedCheckpoint() {
        const database = yield* Database.Service;
        yield* database.query(async (client) => {
          await resetLane(client, assistantId, chatId);
          await client.chat.create({ data: { id: BigInt(chatId) } });
          await client.conversationLane.create({
            data: {
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              pendingRevision: 2,
              processedRevision: 1,
              threadKey: 0,
            },
          });
          const input = await client.conversationInput.create({
            data: {
              admittedRevision: 1,
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              payload: {
                addressed: true,
                date: 1_700_000_005,
                editDate: null,
                forwardOrigin: null,
                messageId: 96,
                repliedText: null,
                replyToMessageId: null,
                senderFirstName: "Alice",
                senderId: 42,
                senderUsername: "alice",
                text: "Hello",
              },
              senderTelegramId: 42n,
              sourceMessageId: 96,
              sourceRevision: "original:96",
              sourceUpdateId: 146,
              threadKey: 0,
            },
          });
          const run = await client.conversationRun.create({
            data: {
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              eligibilityReason: "seed",
              fencingToken: 1n,
              inputEndRevision: 1,
              inputStartRevision: 1,
              inputs: { create: { inputId: input.id, ordinal: 0 } },
              modelProfileFingerprint: Prompt.profileFingerprint(false),
              replyEligible: true,
              threadKey: 0,
            },
          });
          const summaryInput = Prompt.canonicalEncode({
            head: ["turn"],
            previousMemory: "",
            version: "context-checkpoint-v1",
          });
          const parent = await client.conversationContext.create({
            data: {
              activeKey: `v1/${assistantId}/${chatId}/0`,
              assistantId: BigInt(assistantId),
              basePrefixHash: "obsolete-base",
              chatId: BigInt(chatId),
              estimatedStableTokens: 1,
              frozenMemory: Prompt.renderMemory(""),
              frozenMemoryHash: "obsolete-memory",
              generation: 1,
              modelProfileFingerprint: Prompt.profileFingerprint(false),
              stableEnvelope: Prompt.renderEnvelope({ webLookupEnabled: false }),
              stableEnvelopeHash: "obsolete-envelope",
              threadKey: 0,
            },
          });
          const transcriptTurn = await client.conversationTranscriptTurn.create({
            data: {
              assistantId: BigInt(assistantId),
              chatId: BigInt(chatId),
              content: { text: "Hello" },
              idempotencyKey: `${run.id}:0`,
              kind: "userMessage",
              ordinal: 1,
              runId: run.id,
              sourceReferences: {},
              threadKey: 0,
              visibility: "conversation",
            },
          });
          await client.conversationContextTurn.create({
            data: {
              contextId: parent.id,
              estimatedTokens: 2,
              ordinal: 1,
              renderedContent: Prompt.renderTurn({ content: '{"text":"Hello"}', role: "user" }),
              renderVersion: Prompt.renderVersion,
              role: "user",
              rollingPrefixHash: "obsolete-rolling",
              segmentHash: "obsolete-segment",
              transcriptTurnId: transcriptTurn.id,
            },
          });
          await client.conversationRun.update({ where: { id: run.id }, data: { contextId: parent.id } });
          await client.conversationCheckpointAttempt.create({
            data: {
              headEndTurnOrdinal: 1,
              parentContextId: parent.id,
              parentFencingToken: 1n,
              reason: "hardSafety",
              runId: run.id,
              sealedThroughTurnOrdinal: 1,
              status: "failed",
              summaryInput,
              summaryInputHash: new Bun.CryptoHasher("sha256").update(summaryInput).digest("hex"),
              summaryProfileFingerprint: "obsolete-summary-profile",
            },
          });
          await client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { activeRunId: run.id, fencingToken: 1n },
          });
        });
      }),
    );

    await expect(
      runtime.runPromise(
        Effect.gen(function* drainFailedCheckpoint() {
          const conversation = yield* Conversation.Service;
          return yield* conversation.drain({ key });
        }),
      ),
    ).rejects.toMatchObject({ retryable: false });

    const state = await runtime.runPromise(
      Effect.gen(function* inspectPermanentFailure() {
        const database = yield* Database.Service;
        return yield* database.query(async (client) => ({
          attempt: await client.conversationCheckpointAttempt.findFirstOrThrow({
            where: { run: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) } },
          }),
          contexts: await client.conversationContext.findMany({
            where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
          }),
          lane: await client.conversationLane.findUniqueOrThrow({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
          }),
          run: await client.conversationRun.findFirstOrThrow({
            where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
          }),
        }));
      }),
    );

    // A non-retryable summarization failure must terminate the run instead of being redriven
    // forever: failed hardSafety attempts are deliberately resumable with no attempt bound.
    expect(summarizeAttempts).toBe(1);
    expect(state.attempt.status).toBe("failed");
    expect(state.attempt.lastError).toBe("Failed to summarize context");
    expect(state.contexts.map((context) => context.status)).toEqual(["retryNeeded"]);
    expect(state.run.status).toBe("blocked");
    expect(state.run.errorTag).toBe("checkpoint-failed");
    expect(state.lane.activeRunId).toBeNull();
    expect(state.lane.processedRevision).toBe(1);
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

// Each test seeds its own assistant/chat pair; clearing every conversation row for the pair
// (chat last, after its dependents) keeps the suite isolated and order-independent.
async function resetLane(client: PrismaClient, assistantId: number, chatId: number) {
  const where = { assistantId: BigInt(assistantId), chatId: BigInt(chatId) };
  await client.conversationCheckpointAttempt.deleteMany({ where: { parentContext: where } });
  await client.conversationRun.updateMany({ where, data: { contextId: null } });
  await client.conversationContext.deleteMany({ where });
  await client.conversationTranscriptTurn.deleteMany({ where });
  await client.conversationRun.deleteMany({ where });
  await client.memoryObservation.deleteMany({ where: { sourceInput: where } });
  await client.memoryNamespace.deleteMany({ where: { chatId: BigInt(chatId) } });
  await client.conversationInput.deleteMany({ where });
  await client.conversationLane.deleteMany({ where });
  await client.chat.deleteMany({ where: { id: BigInt(chatId) } });
}

function testLayer(
  connectionString: string,
  model: Model.Interface = unavailableModel,
  delivery: TelegramDelivery.Interface = unavailableDelivery,
  optionOverrides: Partial<Conversation.Options> = {},
) {
  const infrastructure = Layer.mergeAll(
    Database.layer(connectionString),
    Layer.succeed(Model.Service)(model),
    Layer.succeed(Exa.Service)(disabledExa),
    Layer.succeed(TelegramDelivery.Service)(delivery),
    Layer.succeed(Memory.Service)({
      forget: () => Effect.die(new Error("Memory forget must not run in conversation tests")),
      freezeContextMemory: () => Effect.succeed(""),
      freezeUserMemory: () => Effect.succeed([]),
    }),
    Conversation.optionsLayer({
      affinitySecret: "test-affinity-secret-with-at-least-32-characters",
      contextEstimateSafetyRatio: 1.15,
      contextHardTokenCap: 900_000,
      contextOutputReserveTokens: 1024,
      contextRetainedTokenTarget: 8000,
      contextSoftTokenCap: 30_000,
      contextToolReserveTokens: 4096,
      leaseMs: 180_000,
      maxWaitMs: 3000,
      quietMs: 1000,
      ...optionOverrides,
      whitelistedDmUserIds: optionOverrides.whitelistedDmUserIds ?? [],
    }),
  );
  const context = ConversationContext.layer.pipe(Layer.provideMerge(infrastructure));
  return Conversation.layer.pipe(Layer.provideMerge(context));
}

const disabledExa: Exa.Interface = {
  isEnabled: () => false,
  tools: {},
};

const unavailableModel: Model.Interface = {
  generate: () => Effect.die(new Error("Model must not run during admission")),
};

const unavailableDelivery: TelegramDelivery.Interface = {
  deliver: () => Effect.die(new Error("Telegram must not run during admission")),
};

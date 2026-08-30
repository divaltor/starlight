import { expect, test } from "bun:test";
import type { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { ChatReply } from "@/ai/chat-reply";
import { ChatTools } from "@/ai/chat-tools";
import { Model } from "@/ai/model";
import { ConversationContext } from "@/context/context";
import { Memory } from "@/memory/memory";
import { Prompt } from "@/context/prompt";
import { Conversation } from "@/conversation/conversation";
import { TelegramDelivery } from "@/conversation/delivery";
import { Database } from "@/services/database";
import { Media } from "@/media/media";

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
          chatType: "supergroup",
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
            media: [],
            mediaGroupId: null,
            repliedMedia: [],
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

test.skipIf(!databaseUrl)("model-selected reply targets are passed to Telegram delivery", async () => {
  const targetMessageId = 9_999_999;
  const delivered: TelegramDelivery.Action[] = [];
  const model: Model.Interface = {
    generate: <Output>() =>
      Effect.succeed({
        finishReason: "stop",
        output: { replies: [{ replyTo: targetMessageId, text: "Hi", type: "text" }] } as Output,
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
          stepCount: 0,
        },
      }),
  };
  const delivery: TelegramDelivery.Interface = {
    deliver: (input) => {
      delivered.push(input.action);
      return Effect.succeed({ telegramMessageId: 901 });
    },
    indicateTyping: () => Effect.void,
  };
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, delivery));
  const assistantId = 8_000_000_104;
  const chatId = -8_000_000_104;
  const key = { assistantId, chatId, threadKey: 0 };

  try {
    const result = await runtime.runPromise(
      Effect.gen(function* run() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        yield* conversation.admit({
          chatTitle: "Reply target test",
          chatType: "supergroup",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            media: [],
            mediaGroupId: null,
            messageId: 104,
            repliedMedia: [],
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "Hello",
          },
          updateId: 204,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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

    expect(result.kind).toBe("completed");
    expect(delivered).toEqual([{ replyTo: targetMessageId, text: "Hi", type: "text" }]);
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

test.skipIf(!databaseUrl)("reuses frozen recalled memory after a retryable model failure", async () => {
  const requests: Model.GenerateInput<unknown>[] = [];
  let recallCount = 0;
  const recallQueries: string[] = [];
  const memory: Memory.Interface = {
    flush: () => Effect.void,
    recall: (input) => {
      recallCount += 1;
      recallQueries.push(input.query);
      return Effect.succeed({ contextMemory: `recalled version ${recallCount}` });
    },
  };
  const model: Model.Interface = {
    generate: <Output>(input: Model.GenerateInput<Output>) => {
      requests.push(input);
      if (requests.length === 1) {
        return Effect.fail(new Model.TimedOut({ message: "Retry model generation", retryable: true }));
      }
      return Effect.succeed({
        finishReason: "stop",
        output: { replies: [{ replyTo: null, text: "Recovered", type: "text" }] } as Output,
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
          stepCount: 0,
        },
      });
    },
  };
  const delivery: TelegramDelivery.Interface = {
    deliver: () => Effect.succeed({ telegramMessageId: 900 }),
    indicateTyping: () => Effect.void,
  };
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, delivery, {}, memory));
  const assistantId = 8_000_000_103;
  const chatId = -8_000_000_103;
  const key = { assistantId, chatId, threadKey: 0 };

  try {
    await runtime.runPromise(
      Effect.gen(function* admit() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        yield* conversation.admit({
          chatTitle: "Recall retry test",
          chatType: "supergroup",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            media: [],
            mediaGroupId: null,
            messageId: 101,
            repliedMedia: [],
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "Remember this",
          },
          updateId: 201,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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
        Effect.gen(function* failFirstAttempt() {
          const conversation = yield* Conversation.Service;
          return yield* conversation.drain({ key });
        }),
      ),
    ).rejects.toBeInstanceOf(Conversation.ConversationError);
    const resumed = await runtime.runPromise(
      Effect.gen(function* resume() {
        const conversation = yield* Conversation.Service;
        return yield* conversation.drain({ key });
      }),
    );

    expect(resumed.kind).toBe("completed");
    expect(recallCount).toBe(1);
    expect(recallQueries).toEqual(["Alice: Remember this"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.messages.some((message) => message.text === "recalled version 1"))).toBe(
      true,
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

test.skipIf(!databaseUrl)("silent batches finalize without invoking mandatory memory recall", async () => {
  let recallCount = 0;
  const memory: Memory.Interface = {
    flush: () => Effect.void,
    recall: () => {
      recallCount += 1;
      return Effect.fail(new Memory.MemoryError({ message: "Recall unavailable", retryable: true }));
    },
  };
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!, unavailableModel, unavailableDelivery, {}, memory));
  const assistantId = 8_000_000_105;
  const chatId = -8_000_000_105;
  const key = { assistantId, chatId, threadKey: 0 };

  try {
    const result = await runtime.runPromise(
      Effect.gen(function* run() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        yield* conversation.admit({
          chatTitle: "Silent batch test",
          chatType: "supergroup",
          chatUsername: null,
          key,
          payload: {
            addressed: false,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            media: [],
            mediaGroupId: null,
            messageId: 105,
            repliedMedia: [],
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "Background chat",
          },
          updateId: 205,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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
    const lane = await runtime.runPromise(
      Effect.gen(function* inspect() {
        const database = yield* Database.Service;
        return yield* database.query((client) =>
          client.conversationLane.findUniqueOrThrow({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
          }),
        );
      }),
    );

    expect(result.kind).toBe("completed");
    expect(recallCount).toBe(0);
    expect(lane.activeRunId).toBeNull();
    expect(lane.processedRevision).toBe(1);
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

test.skipIf(!databaseUrl)("permanent recall rejection blocks only its run and releases the successor", async () => {
  let recallCount = 0;
  const memory: Memory.Interface = {
    flush: () => Effect.void,
    recall: () => {
      recallCount += 1;
      return recallCount === 1
        ? Effect.fail(new Memory.MemoryError({ message: "Recall rejected", retryable: false }))
        : Effect.succeed({ contextMemory: null });
    },
  };
  const model: Model.Interface = {
    generate: <Output>() =>
      Effect.succeed({
        finishReason: "stop",
        output: { replies: [{ replyTo: null, text: "Recovered", type: "text" }] } as Output,
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
          stepCount: 0,
        },
      }),
  };
  const delivered: TelegramDelivery.Action[] = [];
  const delivery: TelegramDelivery.Interface = {
    deliver: (input) => {
      delivered.push(input.action);
      return Effect.succeed({ telegramMessageId: 906 });
    },
    indicateTyping: () => Effect.void,
  };
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, delivery, {}, memory));
  const assistantId = 8_000_000_106;
  const chatId = -8_000_000_106;
  const key = { assistantId, chatId, threadKey: 0 };

  try {
    await runtime.runPromise(
      Effect.gen(function* admitFirst() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        yield* conversation.admit({
          chatTitle: "Permanent recall test",
          chatType: "supergroup",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            media: [],
            mediaGroupId: null,
            messageId: 106,
            repliedMedia: [],
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "First request",
          },
          updateId: 206,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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
        Effect.gen(function* rejectFirst() {
          const conversation = yield* Conversation.Service;
          return yield* conversation.drain({ key });
        }),
      ),
    ).rejects.toMatchObject({ retryable: false });

    await runtime.runPromise(
      Effect.gen(function* admitSuccessor() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* conversation.admit({
          chatTitle: "Permanent recall test",
          chatType: "supergroup",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_001,
            editDate: null,
            forwardOrigin: null,
            media: [],
            mediaGroupId: null,
            messageId: 107,
            repliedMedia: [],
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "Second request",
          },
          updateId: 207,
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
    const state = await runtime.runPromise(
      Effect.gen(function* inspect() {
        const database = yield* Database.Service;
        return yield* database.query(async (client) => ({
          lane: await client.conversationLane.findUniqueOrThrow({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
          }),
          runs: await client.conversationRun.findMany({
            where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
            orderBy: { createdAt: "asc" },
          }),
        }));
      }),
    );

    expect(delivered).toEqual([{ replyTo: null, text: "Recovered", type: "text" }]);
    expect(state.runs.map((run) => run.status)).toEqual(["blocked", "finalized"]);
    expect(state.lane.activeRunId).toBeNull();
    expect(state.lane.processedRevision).toBe(2);
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

test.skipIf(!databaseUrl)("lease ownership loss interrupts active model work", async () => {
  const modelStarted = Deferred.makeUnsafe<true>();
  const modelInterrupted = Deferred.makeUnsafe<true>();
  const model: Model.Interface = {
    generate: () =>
      Deferred.succeed(modelStarted, true).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(modelInterrupted, true).pipe(Effect.asVoid)),
      ),
  };
  const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, unavailableDelivery, { leaseMs: 3000 }));
  const assistantId = 8_000_000_107;
  const chatId = -8_000_000_107;
  const key = { assistantId, chatId, threadKey: 0 };

  try {
    const result = await runtime.runPromise(
      Effect.gen(function* loseLeaseOwnership() {
        const conversation = yield* Conversation.Service;
        const database = yield* Database.Service;
        yield* database.query((client) => resetLane(client, assistantId, chatId));
        yield* conversation.admit({
          chatTitle: "Lease ownership test",
          chatType: "supergroup",
          chatUsername: null,
          key,
          payload: {
            addressed: true,
            date: 1_700_000_000,
            editDate: null,
            forwardOrigin: null,
            media: [],
            mediaGroupId: null,
            messageId: 108,
            repliedMedia: [],
            repliedText: null,
            replyToMessageId: null,
            senderFirstName: "Alice",
            senderId: 42,
            senderUsername: "alice",
            text: "Wait for the model",
          },
          updateId: 208,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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

        const drain = yield* Effect.forkChild(conversation.drain({ key }).pipe(Effect.flip));
        yield* Deferred.await(modelStarted);
        yield* database.query((client) =>
          client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: {
                assistantId: BigInt(assistantId),
                chatId: BigInt(chatId),
                threadKey: 0,
              },
            },
            data: { fencingToken: { increment: 1 } },
          }),
        );
        yield* TestClock.adjust("1 second");
        return {
          error: yield* Fiber.join(drain),
          modelInterrupted: yield* Deferred.isDone(modelInterrupted),
        };
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(result.error).toMatchObject({
      message: "Conversation lease ownership was lost",
      retryable: true,
    });
    expect(result.modelInterrupted).toBe(true);
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
          stepCount: 0,
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
    indicateTyping: () => Effect.void,
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
          chatType: "supergroup",
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
            media: [],
            mediaGroupId: null,
            repliedMedia: [],
            text: "@starlight hello",
          },
          updateId: 111,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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
  "finalized responses remain active until the next request requires preflight context compaction",
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
            stepCount: 0,
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
      indicateTyping: () => Effect.void,
    };
    const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, delivery));
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
            chatType: "supergroup",
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
              media: [],
              mediaGroupId: null,
              repliedMedia: [],
              text: "First",
            },
            updateId: 131,
          });
          yield* database.query((client) =>
            client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
          );
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
            chatType: "supergroup",
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
              media: [],
              mediaGroupId: null,
              repliedMedia: [],
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

      expect(requests).toHaveLength(2);
      expect(requests[1]!.messages.some((message) => message.text.includes("First"))).toBe(true);
      expect(state.contexts.map((context) => context.status)).toEqual(["active"]);
      expect(state.contexts[0]!.turns).toHaveLength(4);
      expect(state.attempts).toHaveLength(0);
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

test.skipIf(!databaseUrl)("a committed checkpoint retries its failed memory flush", async () => {
  const requests: Model.GenerateInput<unknown>[] = [];
  let chatAttempts = 0;
  let flushAttempts = 0;
  const model: Model.Interface = {
    generate: <Output>(input: Model.GenerateInput<Output>) => {
      requests.push(input);
      const chatRequest = !input.instructions.startsWith("Summarize");
      if (chatRequest) chatAttempts += 1;
      if (chatRequest && chatAttempts === 1) {
        return Effect.fail(new Model.ContextOverflow({ message: "Model context limit exceeded", retryable: false }));
      }
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
          stepCount: 0,
        },
      });
    },
  };
  const delivery: TelegramDelivery.Interface = {
    deliver: () => Effect.succeed({ telegramMessageId: 901 }),
    indicateTyping: () => Effect.void,
  };
  const memory: Memory.Interface = {
    flush: () => {
      flushAttempts += 1;
      return flushAttempts === 1
        ? Effect.fail(new Memory.MemoryError({ message: "Retry checkpoint retention", retryable: true }))
        : Effect.void;
    },
    recall: () => Effect.succeed({ contextMemory: null }),
  };
  const runtime = ManagedRuntime.make(
    testLayer(
      databaseUrl!,
      model,
      delivery,
      {
        contextRetainedTokenTarget: 1,
      },
      memory,
    ),
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
          await client.chat.create({ data: { id: BigInt(chatId), isPremium: true } });
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
              modelProfileFingerprint: Prompt.profileFingerprint([]),
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
              modelProfileFingerprint: Prompt.profileFingerprint([]),
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
          chatType: "supergroup",
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
            media: [],
            mediaGroupId: null,
            repliedMedia: [],
            text,
          },
          updateId: 143,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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
        Effect.gen(function* failCheckpointFlush() {
          const conversation = yield* Conversation.Service;
          return yield* conversation.drain({ key });
        }),
      ),
    ).rejects.toMatchObject({ retryable: true });
    await runtime.runPromise(
      Effect.gen(function* resumeCheckpointFlush() {
        const conversation = yield* Conversation.Service;
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

    expect(requests).toHaveLength(3);
    expect(requests[0]!.instructions.startsWith("Summarize")).toBe(false);
    expect(requests[1]!.instructions.startsWith("Summarize")).toBe(true);
    expect(requests[2]!.instructions.startsWith("Summarize")).toBe(false);
    expect(flushAttempts).toBe(2);
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
          stepCount: 0,
        },
      });
    },
  };
  const delivery: TelegramDelivery.Interface = {
    deliver: () => Effect.succeed({ telegramMessageId: 950 }),
    indicateTyping: () => Effect.void,
  };
  const runtime = ManagedRuntime.make(
    testLayer(databaseUrl!, model, delivery, {
      contextCompactionTriggerTokens: 2000,
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
          chatType: "supergroup",
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
            media: [],
            mediaGroupId: null,
            repliedMedia: [],
            text: "oversized ".repeat(20_000),
          },
          updateId: 144,
        });
        yield* database.query((client) =>
          client.chat.update({ where: { id: BigInt(chatId) }, data: { isPremium: true } }),
        );
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
          chatType: "supergroup",
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
            media: [],
            mediaGroupId: null,
            repliedMedia: [],
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
          chatType: "supergroup",
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
            media: [],
            mediaGroupId: null,
            repliedMedia: [],
            text: "Original",
          },
          updateId: 121,
        };
        const edit: Conversation.AdmissionInput = {
          ...original,
          payload: {
            ...original.payload,
            editDate: 1_700_000_000,
            media: [],
            mediaGroupId: null,
            repliedMedia: [],
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
          await client.chat.create({ data: { id: BigInt(chatId), isPremium: true } });
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
              modelProfileFingerprint: Prompt.profileFingerprint([]),
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
              frozenMemory: Prompt.renderMemory({ checkpoint: "", scopes: [] }),
              frozenMemoryHash: "obsolete-memory",
              generation: 1,
              modelProfileFingerprint: Prompt.profileFingerprint([]),
              stableEnvelope: Prompt.renderEnvelope({ toolProfile: [] }),
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
  memory: Memory.Interface = unavailableMemory,
) {
  const chatReply = ChatReply.layer.pipe(Layer.provideMerge(Layer.succeed(Model.Service)(model)));
  const infrastructure = Layer.mergeAll(
    Database.layer(connectionString),
    chatReply,
    Layer.succeed(ChatTools.Service)(disabledChatTools),
    Layer.succeed(TelegramDelivery.Service)(delivery),
    Layer.succeed(Media.Service)({
      ingest: (source) =>
        Effect.succeed({
          availability: "unavailable",
          mimeType: source.mimeType,
          reason: "not used in conversation tests",
          stableDescription: "media unavailable in conversation tests",
          telegramFileId: source.telegramFileId,
          telegramFileUniqueId: source.telegramFileUniqueId,
          type: source.type,
        }),
      load: () => Effect.succeed(null),
    }),
    Layer.succeed(Memory.Service)(memory),
    Conversation.optionsLayer({
      contextCompactionTriggerTokens: 880_000,
      contextRetainedTokenTarget: 8000,
      leaseMs: 180_000,
      maxWaitMs: 3000,
      quietMs: 1000,
      recallMaxQueryTokens: 800,
      ...optionOverrides,
    }),
  );
  const context = ConversationContext.layer.pipe(Layer.provideMerge(infrastructure));
  return Conversation.layer.pipe(Layer.provideMerge(context));
}

const disabledChatTools: ChatTools.Interface = {
  availableProfile: [],
  resolve: (profile) => Effect.succeed({ profile, tools: {} }),
};

const unavailableModel: Model.Interface = {
  generate: () => Effect.die(new Error("Model must not run during admission")),
};

const unavailableMemory: Memory.Interface = {
  flush: () => Effect.void,
  recall: () => Effect.succeed({ contextMemory: null }),
};

const unavailableDelivery: TelegramDelivery.Interface = {
  deliver: () => Effect.die(new Error("Telegram must not run during admission")),
  indicateTyping: () => Effect.void,
};

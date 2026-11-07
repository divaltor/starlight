import { expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Fiber, Layer, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { ChatTools } from "@/ai/chat-tools";
import { Model } from "@/ai/model";
import { Conversation } from "@/conversation/conversation";
import { TelegramDelivery } from "@/conversation/delivery";
import { ConversationKey } from "@/conversation/key";
import { LaneDoc } from "@/conversation/lane-doc";
import { Memory } from "@/memory/memory";
import { Media } from "@/media/media";
import { Database } from "@/services/database";

// Our product must wait through brief harness outages but fail after five minutes
// because unbounded recovery waits retain pending Telegram updates in memory.
test("test_admission_and_history_wait_for_recovery_but_fail_after_five_minutes", async () => {
  const postgres: { openNodePostgresStorage: () => Promise<Storage> } = await import("@netzlabor/pi-durable-postgres");

  const storage = new MemoryStorage();
  const originalClose = storage.close.bind(storage);
  const drained = Promise.withResolvers<null>();

  // Preserve the in-memory store across sessions, with controllable connection cleanup.
  const close = spyOn(storage, "close").mockImplementation(async () => {
    await drained.promise;
  });

  let available = true;

  const open = spyOn(postgres, "openNodePostgresStorage").mockImplementation(async () => {
    if (!available) throw new Error("storage unavailable");

    return await Promise.resolve(storage);
  });

  const baseClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: "postgresql://unused" }) });

  const extendedClient = baseClient.$extends({
    query: {
      $executeRawUnsafe: async () => await Promise.resolve(0),
      $queryRaw: async () => await Promise.resolve([]),
      chat: { upsert: async () => await Promise.resolve({}) },
      message: { upsert: async () => await Promise.resolve({}) },
    },
  });

  const fixture = {};

  const client = Object.assign(fixture, baseClient, extendedClient, {
    $executeRawUnsafe: extendedClient.$executeRawUnsafe.bind(extendedClient),
    $queryRaw: extendedClient.$queryRaw.bind(extendedClient),
  });

  const key = { assistantId: 1, chatId: 42, threadKey: 0 };

  const input: Conversation.AdmissionInput = {
    chatTitle: null,
    chatType: "private",
    chatUsername: null,
    key,
    updateId: 10,
    payload: {
      addressed: false,
      date: 1_700_000_000,
      editDate: null,
      forwardedFromSelf: false,
      forwardOrigin: null,
      media: [],
      mediaGroupId: null,
      messageId: 100,
      repliedMedia: [],
      repliedText: null,
      replyToMessageId: null,
      senderFirstName: "Ann",
      senderId: null,
      senderUsername: null,
      text: "Keep this message",
    },
  };

  const layer = Conversation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Database.Service)({
          query: (operation) =>
            Effect.tryPromise({
              try: async () => await operation(client),
              catch: (cause) => new Database.QueryError({ cause, message: "fixture query failed" }),
            }),
          transaction: (operation) =>
            Effect.tryPromise({
              try: async () => await operation(client),
              catch: (cause) => new Database.TransactionError({ cause, message: "fixture transaction failed" }),
            }),
        }),
        Layer.succeed(ChatTools.Service)({
          availableProfile: [],
          resolve: () => Effect.succeed({ profile: [], tools: {} }),
        }),
        Layer.succeed(TelegramDelivery.Service)({
          deliver: () => Effect.die(new Error("unexpected delivery")),
          indicateTyping: () => Effect.void,
        }),
        Layer.succeed(Media.Service)({
          ingest: () => Effect.die(new Error("unexpected media")),
          load: () => Effect.succeed(null),
        }),
        Layer.succeed(Memory.Service)({
          flush: () => Effect.void,
          recall: () => Effect.succeed({ contextMemory: null }),
          record: () => Effect.void,
        }),
        Layer.succeed(Model.Service)({ generate: () => Effect.die(new Error("unexpected generation")) }),
        Conversation.optionsLayer({
          contextCompactionTriggerTokens: 100_000,
          contextRetainedTokenTarget: 8000,
          databaseUrl: "postgresql://unused",
          maxWaitMs: 60_000,
          openRouterApiKey: "unused",
          quietMs: 60_000,
          recallMaxQueryTokens: 100,
        }),
      ),
    ),
  );

  // Capture the actual harness without replacing its commits, reads or close behavior.
  const durable = await import("@earendil-works/pi-durable");
  const originalOpen = durable.Harness.open.bind(durable.Harness);
  let harness: Harness;

  const opened = spyOn(durable.Harness, "open").mockImplementation(async (...args) => {
    harness = await originalOpen(...args);

    return harness;
  });

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const conversation = yield* Conversation.Service;
        yield* conversation.admit(input);
        available = false;
        const failedRead = spyOn(storage, "findDocument").mockRejectedValueOnce(new Error("connection dropped"));
        yield* Effect.tryPromise(
          async () => await harness.snapshot(LaneDoc.index, "uncached-lane", BACKGROUND_CONTEXT),
        ).pipe(Effect.exit);
        failedRead.mockRestore();
        const history = yield* Effect.forkChild(conversation.recent(key));

        const admission = yield* Effect.forkChild(
          conversation
            .admit({ ...input, updateId: 11, payload: { ...input.payload, messageId: 101, text: "After recovery" } })
            .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 5 })),
        );

        yield* TestClock.adjust("20 seconds");
        expect(admission.pollUnsafe()).toBeUndefined();
        expect(history.pollUnsafe()).toBeUndefined();

        drained.resolve(null);
        yield* Effect.promise(async () => await harness.closed);
        yield* TestClock.adjust("20 seconds");
        expect(admission.pollUnsafe()).toBeUndefined();
        expect(history.pollUnsafe()).toBeUndefined();

        available = true;
        yield* TestClock.adjust("5 seconds");
        expect(yield* Fiber.join(admission)).toEqual({ duplicate: false });
        expect((yield* Fiber.join(history)).map((item) => item.text)).toContain("Keep this message");
        expect((yield* conversation.recent(key)).map((item) => item.text)).toEqual([
          "Keep this message",
          "After recovery",
        ]);

        const index = yield* Effect.promise(
          async () => await harness.snapshot(LaneDoc.index, ConversationKey.format(key), BACKGROUND_CONTEXT),
        );

        const conversationId = index?.conversationId;

        if (conversationId == null) throw new Error("admitted lane missing");

        const lane = yield* Effect.promise(
          async () => await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT),
        );

        expect(lane?.pending.map((item) => item.payload.text)).toEqual(["Keep this message", "After recovery"]);

        available = false;
        const failedAgain = spyOn(storage, "findDocument").mockRejectedValueOnce(new Error("connection dropped again"));
        yield* Effect.tryPromise(
          async () => await harness.snapshot(LaneDoc.index, "another-uncached-lane", BACKGROUND_CONTEXT),
        ).pipe(Effect.exit);
        failedAgain.mockRestore();

        const timedAdmission = yield* Effect.forkChild(
          conversation
            .admit({ ...input, updateId: 12, payload: { ...input.payload, messageId: 102 } })
            .pipe(Effect.flip),
        );

        const timedHistory = yield* Effect.forkChild(conversation.recent(key).pipe(Effect.flip));

        yield* TestClock.adjust("299 seconds");
        expect(timedAdmission.pollUnsafe()).toBeUndefined();
        expect(timedHistory.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("1 second");
        expect(timedAdmission.pollUnsafe()).toBeDefined();
        expect(timedHistory.pollUnsafe()).toBeDefined();
        const admissionError = yield* Fiber.join(timedAdmission);
        expect(admissionError).toBeInstanceOf(Conversation.AdmissionError);
        expect(admissionError).toMatchObject({ retryable: true, cause: { _tag: "TimeoutError" } });
        const historyError = yield* Fiber.join(timedHistory);
        expect(historyError).toBeInstanceOf(Conversation.ReadError);
        expect(historyError.cause).toMatchObject({ _tag: "TimeoutError" });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            drained.resolve(null);
          }),
        ),
        Effect.provide(layer),
        Effect.scoped,
        Effect.provide(TestClock.layer()),
      ),
    );
  } finally {
    opened.mockRestore();
    open.mockRestore();
    close.mockRestore();
    await originalClose(BACKGROUND_CONTEXT);
    await baseClient.$disconnect();
  }
});

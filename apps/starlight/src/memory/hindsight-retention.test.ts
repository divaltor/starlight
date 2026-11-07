import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test } from "bun:test";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Prompt } from "@/context/prompt";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL ?? "";

test.skipIf(!databaseUrl)("retains one replaceable transcript document per conversation", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const assistantId = 8_100_000_001n;
  const chatId = -8_100_000_001n;
  const ownerKey = `conversation:${assistantId}:${chatId}:0`;
  const retained: Hindsight.RetainInput[] = [];

  const runtime = ManagedRuntime.make(
    HindsightRetention.layer.pipe(
      Layer.provideMerge(Database.layer(databaseUrl)),
      Layer.provideMerge(
        Layer.succeed(Hindsight.Service)({
          recall: () => Effect.succeed([]),
          retain: (input) =>
            Effect.sync(() => {
              retained.push(input);
            }),
        }),
      ),
    ),
  );

  try {
    await client.chat.create({ data: { id: chatId } });

    const namespace = await client.memoryNamespace.create({
      data: { chatId, kind: "chat", ownerKey, threadKey: 0 },
    });

    await client.memoryObservation.createMany({
      data: [
        {
          content: {
            author: { firstName: "Alice", isBot: false, lastName: null, username: "alice" },
            messageId: 10,
            reply: null,
            text: "Use Redis",
            timestamp: "2026-08-28T08:00:00.000Z",
          },
          kind: "fact",
          namespaceId: namespace.id,
          sourceChatId: chatId,
          sourceMessageId: 10,
          sourceRevision: 0,
          sourceThreadKey: 0,
          visibility: "sameChat",
        },
        {
          content: {
            author: { firstName: "Bob", isBot: false, lastName: null, username: "bob" },
            messageId: 11,
            reply: { messageId: 10 },
            text: "Agreed",
            timestamp: "2026-08-28T08:01:00.000Z",
          },
          kind: "fact",
          namespaceId: namespace.id,
          sourceChatId: chatId,
          sourceMessageId: 11,
          sourceRevision: 0,
          sourceThreadKey: 0,
          visibility: "sameChat",
        },
      ],
    });

    await runtime.runPromise(
      Effect.gen(function* retainConversation() {
        const retention = yield* HindsightRetention.Service;
        yield* retention.retainPending(namespace.id);
      }),
    );
    await client.memoryObservation.create({
      data: {
        content: {
          author: { firstName: "Alice", isBot: false, lastName: null, username: "alice" },
          messageId: 10,
          reply: null,
          text: "Use Postgres, not Redis",
          timestamp: "2026-08-28T08:00:00.000Z",
        },
        kind: "correction",
        namespaceId: namespace.id,
        sourceChatId: chatId,
        sourceMessageId: 10,
        sourceRevision: 1_756_368_120,
        sourceThreadKey: 0,
        visibility: "sameChat",
      },
    });
    await runtime.runPromise(
      Effect.gen(function* replaceConversation() {
        const retention = yield* HindsightRetention.Service;
        yield* retention.retainPending(namespace.id);
      }),
    );

    expect(retained).toHaveLength(2);
    expect(retained.every((input) => input.bankId === ownerKey && input.items.length === 1)).toBe(true);
    expect(retained.map((input) => input.items[0]!.document_id)).toEqual(["transcript", "transcript"]);
    expect(retained.map((input) => input.items[0]!.update_mode)).toEqual(["replace", "replace"]);
    expect(retained[1]!.items[0]!.content).toBe(
      Prompt.canonicalEncode([
        {
          author: { firstName: "Alice", isBot: false, lastName: null, username: "alice" },
          content: "Use Postgres, not Redis",
          message_id: 10,
          reply: null,
          role: "user",
          timestamp: "2026-08-28T08:00:00.000Z",
        },
        {
          author: { firstName: "Bob", isBot: false, lastName: null, username: "bob" },
          content: "Agreed",
          message_id: 11,
          reply: { messageId: 10 },
          role: "user",
          timestamp: "2026-08-28T08:01:00.000Z",
        },
      ]),
    );
  } finally {
    await runtime.dispose();
    await client.memoryNamespace.deleteMany({ where: { ownerKey } });
    await client.chat.deleteMany({ where: { id: chatId } });
    await client.$disconnect();
  }
});

test.skipIf(!databaseUrl)("test_retains_every_recording_when_transactions_overlap", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const key = { assistantId: 8_100_000_002n, chatId: -8_100_000_002n, threadKey: 0 };
  const ownerKey = `conversation:${key.assistantId}:${key.chatId}:0`;
  const firstInserted = Promise.withResolvers<undefined>();
  const releaseFirst = Promise.withResolvers<undefined>();
  const secondStarted = Promise.withResolvers<number>();
  const recordings: Promise<void>[] = [];
  const retained: Hindsight.RetainInput[] = [];
  let transactions = 0;

  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* pausedRecording() {
      const service = yield* Database.Service;

      return Database.Service.of({
        query: service.query,
        transaction: (operation) =>
          service.transaction(async (transaction) => {
            transactions++;
            const index = transactions;

            if (index === 2) {
              const processes = await transaction.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              secondStarted.resolve(processes[0]!.pid);
            }

            const result = await operation(transaction);

            if (index === 1) {
              firstInserted.resolve(undefined);
              await releaseFirst.promise;
            }

            return result;
          }),
      });
    }),
  ).pipe(Layer.provide(Database.layer(databaseUrl)));

  const hindsight = Layer.succeed(Hindsight.Service)({
    recall: () => Effect.succeed([]),
    retain: (input) =>
      Effect.sync(() => {
        retained.push(input);
      }),
  });

  const runtime = ManagedRuntime.make(
    Memory.layer.pipe(
      Layer.provideMerge(HindsightRetention.layer.pipe(Layer.provideMerge(Layer.mergeAll(database, hindsight)))),
    ),
  );

  try {
    await client.chat.create({ data: { id: key.chatId } });

    const namespace = await client.memoryNamespace.create({
      data: { chatId: key.chatId, kind: "chat", ownerKey, threadKey: 0 },
    });

    const memory = await runtime.runPromise(Memory.Service);
    const retention = await runtime.runPromise(HindsightRetention.Service);

    const payload = {
      addressed: true,
      date: 1_782_000_000,
      editDate: null,
      forwardOrigin: null,
      forwardedFromSelf: false,
      media: [],
      mediaGroupId: null,
      repliedMedia: [],
      repliedText: null,
      replyToMessageId: null,
      senderFirstName: "Alice",
      senderId: 42,
      senderUsername: "alice",
    };

    recordings.push(
      runtime.runPromise(
        memory.record(key, [{ payload: { ...payload, messageId: 10, text: "Use Postgres" }, senderUserId: null }]),
      ),
    );
    await firstInserted.promise;
    recordings.push(
      runtime.runPromise(
        memory.record(key, [{ payload: { ...payload, messageId: 11, text: "Deploy on Friday" }, senderUserId: null }]),
      ),
    );
    const secondPid = await secondStarted.promise;

    // Wait for the second writer to commit or block behind the first, without a timing assumption.
    while (true) {
      const processes = await client.$queryRaw<{ settled: boolean }[]>`
        SELECT state = 'idle' OR cardinality(pg_blocking_pids(pid)) > 0 AS settled
        FROM pg_stat_activity WHERE pid = ${secondPid}
      `;

      if (processes[0]!.settled) break;
    }

    await runtime.runPromise(retention.retainPending(namespace.id));
    releaseFirst.resolve(undefined);
    await Promise.all(recordings);
    await runtime.runPromise(retention.retainPending(namespace.id));

    expect(retained.at(-1)!.items[0]!.content).toContain("Use Postgres");
    expect(retained.at(-1)!.items[0]!.content).toContain("Deploy on Friday");
    const stored = await client.memoryNamespace.findUniqueOrThrow({ where: { id: namespace.id } });

    const observations = await client.memoryObservation.findMany({
      where: { namespaceId: namespace.id },
      orderBy: { id: "asc" },
    });

    expect(stored.retentionWatermark).toBe(observations.at(-1)!.id);
  } finally {
    releaseFirst.resolve(undefined);
    await Promise.allSettled(recordings);
    await runtime.dispose();
    await client.chat.deleteMany({ where: { id: key.chatId } });
    await client.$disconnect();
  }
});

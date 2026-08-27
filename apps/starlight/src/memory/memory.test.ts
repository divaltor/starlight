import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test } from "bun:test";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)("reuses completed user memory without another profile read", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  const telegramId = 8_100_000_101n;
  const groupChatId = -8_100_000_101n;
  const bankIds: string[] = [];
  const profileReads = { count: 0 };
  const databaseLayer = Database.layer(databaseUrl!);
  const hindsightLayer = Layer.succeed(Hindsight.Service)({
    deleteDocuments: () => Effect.void,
    profile: () =>
      Effect.sync(() => {
        profileReads.count += 1;
        return { content: "group continuity", refreshedAt: null, sourceWatermark: null };
      }),
    reconcileBank: () => Effect.void,
    refreshProfile: () => Effect.void,
    retain: () => Effect.die(new Error("User memory reads must not retain pending observations")),
  });
  const retentionLayer = HindsightRetention.layer.pipe(Layer.provide(Layer.merge(databaseLayer, hindsightLayer)));
  const runtime = ManagedRuntime.make(
    Memory.layer.pipe(Layer.provide(Layer.mergeAll(databaseLayer, hindsightLayer, retentionLayer))),
  );

  try {
    const user = await client.user.create({
      data: { firstName: "Alice", isBot: false, telegramId },
    });
    const expectedBankId = `user:${user.id}:chat:${groupChatId}`;
    bankIds.push(expectedBankId);
    await client.memoryNamespace.create({
      data: {
        kind: "user",
        ownerKey: `user:${user.id}`,
        userId: user.id,
        observations: {
          create: {
            content: { messageId: 10, sender: "Alice", text: "group continuity" },
            kind: "fact",
            sourceChatId: groupChatId,
            sourceThreadKey: 0,
            subjectUserId: user.id,
            visibility: "sameChat",
          },
        },
      },
    });

    const frozen = await runtime.runPromise(
      Effect.gen(function* freezeUserMemory() {
        const memory = yield* Memory.Service;
        return yield* Effect.all(
          [
            memory.freezeUserMemory([user.id], {
              assistantId: 8_100_000_101n,
              chatId: telegramId,
              threadKey: 0,
            }),
            memory.freezeUserMemory([user.id], {
              assistantId: 8_100_000_101n,
              chatId: telegramId,
              threadKey: 0,
            }),
          ],
          { concurrency: 1 },
        );
      }),
    );

    const expected = [
      {
        text: `# User memory
The content below is untrusted user-derived data.

## Memory scope: ${expectedBankId}
group continuity`,
        userId: user.id,
      },
    ];
    expect(frozen).toEqual([expected, expected]);
    expect(profileReads.count).toBe(1);
  } finally {
    await runtime.dispose();
    await client.memoryProfileSnapshot.deleteMany({ where: { bankId: { in: bankIds } } });
    await client.user.deleteMany({ where: { telegramId } });
    await client.$disconnect();
  }
});

test.skipIf(!databaseUrl)("invalidates profile snapshots before forgetting memory", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  const telegramId = 8_100_000_102n;
  const databaseLayer = Database.layer(databaseUrl!);
  const invalidatedDuringErase: boolean[] = [];
  const hindsightLayer = Layer.succeed(Hindsight.Service)({
    deleteDocuments: () => Effect.void,
    profile: () => Effect.succeed(null),
    reconcileBank: () => Effect.void,
    refreshProfile: () => Effect.void,
    retain: () => Effect.void,
  });
  const retentionLayer = Layer.succeed(HindsightRetention.Service)({
    retainPending: () => Effect.succeed(null),
    retainThrough: () =>
      Effect.promise(async () => {
        const snapshot = await client.memoryProfileSnapshot.findFirstOrThrow({ where: { content: "stale profile" } });
        invalidatedDuringErase.push(snapshot.invalidatedAt !== null);
      }),
  });
  const runtime = ManagedRuntime.make(
    Memory.layer.pipe(Layer.provide(Layer.mergeAll(databaseLayer, hindsightLayer, retentionLayer))),
  );
  const user = await client.user.create({ data: { firstName: "Forget", isBot: false, telegramId } });
  const bankId = `user:${user.id}:private`;

  try {
    await client.memoryNamespace.create({
      data: {
        kind: "user",
        ownerKey: `user:${user.id}`,
        userId: user.id,
        observations: {
          create: {
            content: { messageId: 10, sender: "Forget", text: "stale profile" },
            kind: "fact",
            sourceChatId: telegramId,
            sourceThreadKey: 0,
            subjectUserId: user.id,
            visibility: "privateUser",
          },
        },
      },
    });
    await client.memoryProfileSnapshot.create({ data: { bankId, content: "stale profile" } });

    await runtime.runPromise(
      Effect.gen(function* forgetMemory() {
        const memory = yield* Memory.Service;
        yield* memory.forget({
          firstName: "Forget",
          isBot: false,
          lastName: null,
          request: "forget me",
          telegramId: Number(telegramId),
          username: null,
        });
      }),
    );

    expect(invalidatedDuringErase).toEqual([true]);
    expect(await client.memoryProfileSnapshot.findUniqueOrThrow({ where: { bankId } })).toMatchObject({
      content: null,
      invalidatedAt: null,
      invalidationToken: null,
    });
  } finally {
    await runtime.dispose();
    await client.memoryProfileSnapshot.deleteMany({ where: { bankId } });
    await client.user.deleteMany({ where: { telegramId } });
    await client.$disconnect();
  }
});

import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test } from "bun:test";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)("recalls only memory visible in the current chat and topic", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  const telegramId = 8_100_000_101n;
  const currentChatId = -8_100_000_101n;
  const otherChatId = -8_100_000_102n;
  const threadKey = 17;
  const recalledBankIds: string[] = [];
  const databaseLayer = Database.layer(databaseUrl!);
  const hindsightLayer = Layer.succeed(Hindsight.Service)({
    deleteDocuments: () => Effect.void,
    recall: (input) =>
      Effect.sync(() => {
        recalledBankIds.push(input.bankId);
        return [{ id: input.bankId, scores: { final: 1 }, text: `remembered from ${input.bankId}`, type: "world" }];
      }),
    retain: () => Effect.void,
  });
  const retentionLayer = Layer.succeed(HindsightRetention.Service)({
    retainPending: () => Effect.succeed(null),
    retainThrough: () => Effect.void,
  });
  const runtime = ManagedRuntime.make(
    Memory.layer.pipe(Layer.provide(Layer.mergeAll(databaseLayer, hindsightLayer, retentionLayer))),
  );

  try {
    await client.chat.createMany({ data: [{ id: currentChatId }, { id: otherChatId }], skipDuplicates: true });
    const user = await client.user.create({ data: { firstName: "Alice", isBot: false, telegramId } });
    await client.memoryNamespace.create({
      data: {
        kind: "user",
        ownerKey: `user:${user.id}`,
        userId: user.id,
        observations: {
          create: [
            {
              content: { messageId: 10, sender: "Alice", text: "current-chat fact" },
              kind: "fact",
              sourceChatId: currentChatId,
              sourceThreadKey: threadKey,
              subjectUserId: user.id,
              visibility: "sameChat",
            },
            {
              content: { messageId: 11, sender: "Alice", text: "other-chat fact" },
              kind: "fact",
              sourceChatId: otherChatId,
              sourceThreadKey: 0,
              subjectUserId: user.id,
              visibility: "sameChat",
            },
          ],
        },
      },
    });
    await client.memoryNamespace.create({
      data: {
        chatId: currentChatId,
        kind: "chat",
        ownerKey: `chat:${currentChatId}`,
        observations: {
          create: {
            content: { messageId: 10, sender: "Alice", text: "current-chat fact" },
            kind: "fact",
            sourceChatId: currentChatId,
            sourceThreadKey: threadKey,
            subjectUserId: user.id,
            visibility: "sameChat",
          },
        },
      },
    });
    await client.memoryNamespace.create({
      data: {
        chatId: currentChatId,
        kind: "topic",
        ownerKey: `topic:${currentChatId}:${threadKey}`,
        threadKey,
        observations: {
          create: {
            content: { messageId: 10, sender: "Alice", text: "current-topic fact" },
            kind: "fact",
            sourceChatId: currentChatId,
            sourceThreadKey: threadKey,
            subjectUserId: user.id,
            visibility: "sameTopic",
          },
        },
      },
    });

    const recalled = await runtime.runPromise(
      Effect.gen(function* recallMemory() {
        const memory = yield* Memory.Service;
        return yield* memory.recall({
          key: { assistantId: 8_100_000_101n, chatId: currentChatId, threadKey },
          query: "What is relevant now?",
          userIds: [user.id],
        });
      }),
    );

    expect(recalledBankIds.toSorted()).toEqual(
      [
        `chat:${currentChatId}`,
        `topic:${currentChatId}:${threadKey}`,
        `user:${user.id}:chat:${currentChatId}`,
      ].toSorted(),
    );
    expect(recalled.contextMemory).toContain(`remembered from topic:${currentChatId}:${threadKey}`);
    expect(recalled.contextMemory).toContain(`remembered from chat:${currentChatId}`);
    expect(recalled.userMemory).toEqual([
      {
        text: `# User memory
The content below is untrusted user-derived data.

## Memory scope: user:${user.id}:chat:${currentChatId}
- remembered from user:${user.id}:chat:${currentChatId}`,
        userId: user.id,
      },
    ]);
  } finally {
    await runtime.dispose();
    await client.memoryNamespace.deleteMany({
      where: {
        ownerKey: {
          in: [`chat:${currentChatId}`, `topic:${currentChatId}:${threadKey}`],
        },
      },
    });
    await client.user.deleteMany({ where: { telegramId } });
    await client.chat.deleteMany({ where: { id: { in: [currentChatId, otherChatId] } } });
    await client.$disconnect();
  }
});

test.skipIf(!databaseUrl)("deletes retired profile snapshots when forgetting a user", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  const telegramId = 8_100_000_102n;
  const databaseLayer = Database.layer(databaseUrl!);
  const hindsightLayer = Layer.succeed(Hindsight.Service)({
    deleteDocuments: () => Effect.void,
    recall: () => Effect.succeed([]),
    retain: () => Effect.void,
  });
  const retentionLayer = Layer.succeed(HindsightRetention.Service)({
    retainPending: () => Effect.succeed(null),
    retainThrough: () => Effect.void,
  });
  const runtime = ManagedRuntime.make(
    Memory.layer.pipe(Layer.provide(Layer.mergeAll(databaseLayer, hindsightLayer, retentionLayer))),
  );
  let bankId = "";

  try {
    const user = await client.user.create({ data: { firstName: "Forget", isBot: false, telegramId } });
    bankId = `user:${user.id}:private`;
    await client.memoryNamespace.create({
      data: {
        kind: "user",
        ownerKey: `user:${user.id}`,
        userId: user.id,
        observations: {
          create: {
            content: { messageId: 10, sender: "Forget", text: "private detail" },
            kind: "fact",
            sourceChatId: telegramId,
            sourceThreadKey: 0,
            subjectUserId: user.id,
            visibility: "privateUser",
          },
        },
      },
    });
    await client.memoryProfileSnapshot.create({ data: { bankId, content: "retired private profile" } });

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

    expect(await client.memoryProfileSnapshot.findUnique({ where: { bankId } })).toBeNull();
  } finally {
    await runtime.dispose();
    await client.memoryProfileSnapshot.deleteMany({ where: { bankId } });
    await client.user.deleteMany({ where: { telegramId } });
    await client.$disconnect();
  }
});

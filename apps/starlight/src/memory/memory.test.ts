import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, test } from "bun:test";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Model } from "@/ai/model";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;

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

test.skipIf(!databaseUrl)(
  "forget marks shared-chat lanes reset-pending even when the user never posted there",
  async () => {
    const fixtures = {
      assistantId: 8_000_001_001,
      chatIds: [-8_000_001_001, -8_000_001_002],
      telegramId: 8_000_001_901,
    };
    const client = testClient(databaseUrl!);
    const runtime = ManagedRuntime.make(memoryLayer(databaseUrl!, idleModel));

    try {
      await clearMemoryFixtures(client, fixtures);
      await seedForgetScenario(client, fixtures);

      const result = await runtime.runPromise(
        Effect.gen(function* forget() {
          const memory = yield* Memory.Service;
          return yield* memory.forget({
            firstName: "Carol",
            isBot: false,
            lastName: null,
            request: "forget everything about me",
            telegramId: fixtures.telegramId!,
            username: null,
          });
        }),
      );
      expect(result.affectedLanes).toBe(2);
      expect(result.observations).toBe(2);

      // Both threads of the affected chat reset; the unrelated chat does not.
      const affectedLanes = await client.conversationLane.findMany({
        where: { assistantId: BigInt(fixtures.assistantId), chatId: BigInt(fixtures.chatIds[0]!) },
        orderBy: { threadKey: "asc" },
        select: { contextResetPending: true, threadKey: true },
      });
      expect(affectedLanes).toEqual([
        { contextResetPending: true, threadKey: 1 },
        { contextResetPending: true, threadKey: 2 },
      ]);
      const unaffectedLane = await client.conversationLane.findUniqueOrThrow({
        where: {
          assistantId_chatId_threadKey: {
            assistantId: BigInt(fixtures.assistantId),
            chatId: BigInt(fixtures.chatIds[1]!),
            threadKey: 0,
          },
        },
        select: { contextResetPending: true },
      });
      expect(unaffectedLane.contextResetPending).toBe(false);
      const forgetObservations = await client.memoryObservation.findMany({
        where: { kind: "forget", namespace: { chatId: BigInt(fixtures.chatIds[0]!) } },
        select: { content: true, visibility: true },
      });
      expect(forgetObservations).toEqual([
        { content: { request: "forget everything about me" }, visibility: "privateUser" },
      ]);
    } finally {
      await clearMemoryFixtures(client, fixtures).catch(() => {});
      await client.$disconnect();
      await runtime.dispose();
    }
  },
);

test.skipIf(!databaseUrl)("build rebases a stale-parent attempt and publishes instead of stranding", async () => {
  const fixtures = { assistantId: 8_000_001_003, chatIds: [-8_000_001_003] };
  const client = testClient(databaseUrl!);

  try {
    await clearMemoryFixtures(client, fixtures);
    await seedBuildNamespace(client, fixtures);
    const namespace = await client.memoryNamespace.findUniqueOrThrow({
      where: { ownerKey: `chat:${fixtures.chatIds[0]}` },
    });
    const firstObservation = await client.memoryObservation.findFirstOrThrow({
      where: { namespaceId: namespace.id },
      orderBy: { id: "asc" },
    });

    const firstRuntime = ManagedRuntime.make(memoryLayer(databaseUrl!, builderModel([firstObservation.id.toString()])));
    try {
      await firstRuntime.runPromise(
        Effect.gen(function* firstBuild() {
          const memory = yield* Memory.Service;
          yield* memory.build(namespace.id);
        }),
      );
    } finally {
      await firstRuntime.dispose();
    }
    const afterFirstBuild = await client.memoryNamespace.findUniqueOrThrow({ where: { id: namespace.id } });
    expect(afterFirstBuild.latestRevisionId).not.toBeNull();

    const nextObservation = await client.memoryObservation.create({
      data: {
        content: {},
        kind: "fact",
        namespaceId: namespace.id,
        sourceChatId: BigInt(fixtures.chatIds[0]!),
        sourceThreadKey: 0,
        visibility: "sameChat",
      },
    });
    // Simulates an attempt that lost the publication race: its parent is behind the
    // current latest revision, and the unique watermark key blocks a replacement
    // attempt for the same sourceThrough.
    await client.memoryBuildAttempt.create({
      data: {
        frozenObservationIds: [],
        namespaceId: namespace.id,
        parentRevisionId: crypto.randomUUID(),
        sourceThrough: nextObservation.id,
      },
    });

    const secondRuntime = ManagedRuntime.make(memoryLayer(databaseUrl!, builderModel([nextObservation.id.toString()])));
    try {
      await secondRuntime.runPromise(
        Effect.gen(function* rebuildAfterLostRace() {
          const memory = yield* Memory.Service;
          yield* memory.build(namespace.id);
        }),
      );
    } finally {
      await secondRuntime.dispose();
    }

    const afterRebuild = await client.memoryNamespace.findUniqueOrThrow({ where: { id: namespace.id } });
    expect(afterRebuild.latestRevisionId).not.toBeNull();
    expect(afterRebuild.latestRevisionId).not.toBe(afterFirstBuild.latestRevisionId);
    const processed = await client.memoryObservation.findUniqueOrThrow({ where: { id: nextObservation.id } });
    expect(processed.processedRevisionId).toBe(afterRebuild.latestRevisionId);
    const attempt = await client.memoryBuildAttempt.findUniqueOrThrow({
      where: { namespaceId_sourceThrough: { namespaceId: namespace.id, sourceThrough: nextObservation.id } },
    });
    expect(attempt.status).toBe("published");
  } finally {
    await clearMemoryFixtures(client, fixtures).catch(() => {});
    await client.$disconnect();
  }
});

function memoryLayer(connectionString: string, model: Model.Interface) {
  const infrastructure = Layer.mergeAll(
    Database.layer(connectionString),
    Layer.succeed(Model.Service)(model),
    Memory.optionsLayer({ sensitiveConfidenceMin: 0.9 }),
  );
  return Memory.layer.pipe(Layer.provideMerge(infrastructure));
}

const idleModel: Model.Interface = {
  generate: () => Effect.die(new Error("Model must not run during forget")),
};

// Returns exactly the shape Memory.build requests; the cast only satisfies the generic
// OUTPUT parameter of Model.Interface.generate.
function builderModel(sourceObservationIds: readonly string[]): Model.Interface {
  return {
    generate: <OUTPUT>() =>
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- stub satisfies the generic OUTPUT contract
      Effect.succeed({
        finishReason: "stop",
        output: {
          items: [{ confidence: 0.5, content: "durable fact", sensitive: false, sourceObservationIds }],
        },
        steps: [],
        toolEvents: [],
        transcript: [],
        usage: {
          billing: {
            cacheReadTokens: null,
            cacheWriteTokens: null,
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
          },
          contextInputTokens: null,
          steps: [],
          validForCostThresholds: true,
        },
      }) as unknown as Effect.Effect<Model.GenerationResult<OUTPUT>, Model.Error>,
  };
}

function testClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

interface MemoryFixtures {
  readonly assistantId: number;
  readonly chatIds: number[];
  readonly telegramId?: number;
}

// Deletes only rows created by these fixtures; namespace deletion cascades its
// observations and build attempts, and the user row cascades its private namespace.
async function clearMemoryFixtures(client: PrismaClient, fixtures: MemoryFixtures) {
  const chatIds = fixtures.chatIds.map(BigInt);
  await client.memoryNamespace.deleteMany({ where: { chatId: { in: chatIds } } });
  if (fixtures.telegramId !== undefined) {
    await client.user.deleteMany({ where: { telegramId: BigInt(fixtures.telegramId) } });
  }
  await client.conversationInput.deleteMany({
    where: { assistantId: BigInt(fixtures.assistantId), chatId: { in: chatIds } },
  });
  await client.conversationLane.deleteMany({
    where: { assistantId: BigInt(fixtures.assistantId), chatId: { in: chatIds } },
  });
  await client.chat.deleteMany({ where: { id: { in: chatIds } } });
}

async function seedForgetScenario(client: PrismaClient, fixtures: MemoryFixtures) {
  const chatIds = fixtures.chatIds.map(BigInt);
  await client.chat.createMany({ data: chatIds.map((chatId) => ({ id: chatId })) });
  await client.conversationLane.createMany({
    data: [
      { assistantId: BigInt(fixtures.assistantId), chatId: chatIds[0]!, threadKey: 1 },
      { assistantId: BigInt(fixtures.assistantId), chatId: chatIds[0]!, threadKey: 2 },
      { assistantId: BigInt(fixtures.assistantId), chatId: chatIds[1]! },
    ],
  });
  const user = await client.user.upsert({
    where: { telegramId: BigInt(fixtures.telegramId!) },
    create: {
      firstName: "Carol",
      isBot: false,
      lastName: null,
      telegramId: BigInt(fixtures.telegramId!),
      username: null,
    },
    update: {},
  });
  await client.conversationInput.create({
    data: {
      admittedRevision: 1,
      assistantId: BigInt(fixtures.assistantId),
      chatId: chatIds[0]!,
      payload: { messageId: 1, senderFirstName: "Carol", text: "hello" },
      senderTelegramId: BigInt(fixtures.telegramId!),
      senderUserId: user.id,
      sourceMessageId: 1,
      sourceRevision: "0",
      threadKey: 1,
    },
  });
  // The shared chat namespace embeds this observation into every thread of the chat,
  // including threads where the user never posted.
  const namespace = await client.memoryNamespace.create({
    data: { chatId: chatIds[0]!, kind: "chat", ownerKey: `chat:${chatIds[0]}` },
  });
  await client.memoryObservation.create({
    data: {
      content: { text: "hello" },
      kind: "fact",
      namespaceId: namespace.id,
      sourceChatId: chatIds[0]!,
      sourceThreadKey: 1,
      subjectUserId: user.id,
      visibility: "sameChat",
    },
  });
}

async function seedBuildNamespace(client: PrismaClient, fixtures: MemoryFixtures) {
  const chatId = BigInt(fixtures.chatIds[0]!);
  await client.chat.create({ data: { id: chatId } });
  await client.conversationLane.create({ data: { assistantId: BigInt(fixtures.assistantId), chatId } });
  const namespace = await client.memoryNamespace.create({
    data: { chatId, kind: "chat", ownerKey: `chat:${chatId}` },
  });
  await client.memoryObservation.create({
    data: {
      content: { text: "observed fact" },
      kind: "fact",
      namespaceId: namespace.id,
      sourceChatId: chatId,
      sourceThreadKey: 0,
      visibility: "sameChat",
    },
  });
}

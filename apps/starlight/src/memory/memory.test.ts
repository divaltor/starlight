import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test } from "bun:test";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Prompt } from "@/context/prompt";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)("recalls only the current conversation bank", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  const assistantId = 8_100_000_101n;
  const chatId = -8_100_000_101n;
  const threadKey = 17;
  const ownerKey = `conversation:${assistantId}:${chatId}:${threadKey}`;
  const recalledBankIds: string[] = [];
  const databaseLayer = Database.layer(databaseUrl!);
  const hindsightLayer = Layer.succeed(Hindsight.Service)({
    recall: (input) =>
      Effect.sync(() => {
        recalledBankIds.push(input.bankId);
        return [{ id: input.bankId, scores: { final: 1 }, text: "Alice chose Postgres", type: "world" }];
      }),
    retain: () => Effect.void,
  });
  const retentionLayer = Layer.succeed(HindsightRetention.Service)({
    flush: () => Effect.void,
    retainPending: () => Effect.succeed(null),
  });
  const runtime = ManagedRuntime.make(
    Memory.layer.pipe(Layer.provide(Layer.mergeAll(databaseLayer, hindsightLayer, retentionLayer))),
  );

  try {
    await client.chat.create({ data: { id: chatId } });
    await client.conversationLane.create({ data: { assistantId, chatId, threadKey } });
    const context = await client.conversationContext.create({
      data: {
        assistantId,
        chatId,
        generation: 0,
        modelProfileFingerprint: Prompt.profileFingerprint([]),
        summaryThroughInputSequence: 1n,
        threadKey,
        ...Prompt.stableSeed(Prompt.renderEnvelope({ toolProfile: [] }), ""),
      },
    });
    await client.conversationLane.update({
      where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey } },
      data: { activeContextId: context.id },
    });
    await client.memoryNamespace.create({
      data: {
        chatId,
        kind: "topic",
        ownerKey,
        retentionWatermark: 1n,
        threadKey,
      },
    });

    const recalled = await runtime.runPromise(
      Effect.gen(function* recallMemory() {
        const memory = yield* Memory.Service;
        return yield* memory.recall({
          key: { assistantId, chatId, threadKey },
          query: "Which database did Alice choose?",
        });
      }),
    );

    expect(recalledBankIds).toEqual([ownerKey]);
    expect(recalled.contextMemory).toContain("Alice chose Postgres");
  } finally {
    await runtime.dispose();
    await client.memoryNamespace.deleteMany({ where: { ownerKey } });
    await client.conversationLane.deleteMany({ where: { assistantId, chatId, threadKey } });
    await client.chat.deleteMany({ where: { id: chatId } });
    await client.$disconnect();
  }
});

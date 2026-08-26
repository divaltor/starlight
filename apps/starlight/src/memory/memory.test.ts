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

test.skipIf(!databaseUrl)("freezes completed user memory without waiting for pending retention", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  const telegramId = 8_100_000_101n;
  const groupChatId = -8_100_000_101n;
  const databaseLayer = Database.layer(databaseUrl!);
  const hindsightLayer = Layer.succeed(Hindsight.Service)({
    deleteDocuments: () => Effect.void,
    profile: () => Effect.succeed("group continuity"),
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
        return yield* memory.freezeUserMemory([user.id], {
          assistantId: 8_100_000_101n,
          chatId: telegramId,
          threadKey: 0,
        });
      }),
    );

    expect(frozen).toEqual([
      {
        text: Prompt.canonicalEncode({
          label: "User memory",
          scopes: [{ bankId: expectedBankId, memory: "group continuity" }],
          trust: "untrusted-user-derived-data",
        }),
        userId: user.id,
      },
    ]);
  } finally {
    await runtime.dispose();
    await client.user.deleteMany({ where: { telegramId } });
    await client.$disconnect();
  }
});

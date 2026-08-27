import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, test } from "bun:test";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("Hindsight retention", () => {
  test("refreshes profiles only when deleting the requesting user's documents", async () => {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
    const ownerKey = `chat:${crypto.randomUUID()}`;
    const deleted: { readonly bankId: string; readonly documentIds: readonly string[] }[] = [];
    const refreshed: string[] = [];
    const retained: Hindsight.RetainInput[] = [];
    const runtime = ManagedRuntime.make(
      HindsightRetention.layer.pipe(
        Layer.provideMerge(Database.layer(databaseUrl!)),
        Layer.provideMerge(
          Layer.succeed(Hindsight.Service)({
            deleteDocuments: (bankId, documentIds) =>
              Effect.sync(() => {
                deleted.push({ bankId, documentIds });
              }),
            profile: () => Effect.succeed(null),
            reconcileBank: () => Effect.void,
            refreshProfile: (bankId) =>
              Effect.sync(() => {
                refreshed.push(bankId);
              }),
            retain: (input) =>
              Effect.sync(() => {
                retained.push(input);
              }),
          }),
        ),
      ),
    );

    try {
      const chat = await client.chat.create({ data: { id: -8_100_000_001n } });
      const requester = await client.user.create({
        data: { firstName: "Requester", isBot: false, telegramId: 8_100_000_001n },
      });
      const other = await client.user.create({
        data: { firstName: "Other", isBot: false, telegramId: 8_100_000_002n },
      });
      const namespace = await client.memoryNamespace.create({
        data: { chatId: chat.id, kind: "chat", ownerKey },
      });
      await client.$transaction([
        client.memoryObservation.create({
          data: {
            content: { messageId: 10, sender: "Requester", text: "old detail" },
            kind: "fact",
            namespaceId: namespace.id,
            sourceChatId: chat.id,
            sourceThreadKey: 0,
            subjectUserId: requester.id,
            visibility: "sameChat",
          },
        }),
        client.memoryObservation.create({
          data: {
            content: { messageId: 11, sender: "Other", text: "other detail" },
            kind: "fact",
            namespaceId: namespace.id,
            sourceChatId: chat.id,
            sourceThreadKey: 0,
            subjectUserId: other.id,
            visibility: "sameChat",
          },
        }),
      ]);

      await runtime.runPromise(
        Effect.gen(function* retainPending() {
          const retention = yield* HindsightRetention.Service;
          yield* retention.retainPending(namespace.id);
        }),
      );

      expect(refreshed).toEqual([]);

      const observations = await client.$transaction([
        client.memoryObservation.create({
          data: {
            content: { request: "forget me" },
            kind: "forget",
            namespaceId: namespace.id,
            sourceChatId: 8_100_000_001n,
            sourceThreadKey: 0,
            subjectUserId: requester.id,
            visibility: "privateUser",
          },
        }),
        client.memoryObservation.create({
          data: {
            content: { messageId: 12, sender: "Requester", text: "new detail" },
            kind: "fact",
            namespaceId: namespace.id,
            sourceChatId: chat.id,
            sourceThreadKey: 0,
            subjectUserId: requester.id,
            visibility: "sameChat",
          },
        }),
      ]);

      await runtime.runPromise(
        Effect.gen(function* retainPending() {
          const retention = yield* HindsightRetention.Service;
          yield* retention.retainPending(namespace.id);
        }),
      );

      expect(retained).toHaveLength(1);
      expect(retained[0]!.items.map((item) => item.document_id)).toEqual([
        `message:${chat.id}:10`,
        `message:${chat.id}:11`,
      ]);
      expect(deleted).toEqual([{ bankId: ownerKey, documentIds: [`message:${chat.id}:10`] }]);
      expect(refreshed).toEqual([ownerKey]);
      expect(await client.memoryNamespace.findUniqueOrThrow({ where: { id: namespace.id } })).toMatchObject({
        retentionWatermark: observations[0]!.id,
      });
    } finally {
      await runtime.dispose();
      await client.memoryNamespace.deleteMany({ where: { ownerKey } });
      await client.user.deleteMany({ where: { telegramId: { in: [8_100_000_001n, 8_100_000_002n] } } });
      await client.chat.deleteMany({ where: { id: -8_100_000_001n } });
      await client.$disconnect();
    }
  });
});

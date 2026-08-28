import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test } from "bun:test";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Prompt } from "@/context/prompt";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)("retains one replaceable transcript document per conversation", async () => {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  const assistantId = 8_100_000_001n;
  const chatId = -8_100_000_001n;
  const ownerKey = `conversation:${assistantId}:${chatId}:0`;
  const retained: Hindsight.RetainInput[] = [];
  const runtime = ManagedRuntime.make(
    HindsightRetention.layer.pipe(
      Layer.provideMerge(Database.layer(databaseUrl!)),
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

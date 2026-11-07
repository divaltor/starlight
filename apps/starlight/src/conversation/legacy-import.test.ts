import { expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { CompactionEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect } from "effect";
import { ConversationKey } from "@/conversation/key";
import { LaneDoc } from "@/conversation/lane-doc";
import { LegacyImport } from "@/conversation/legacy-import";
import { Database } from "@/services/database";

// Our product must resume legacy history in the same conversation without missing or duplicate
// turns, because interrupted startup must not orphan persisted chat history.
test.each([
  { afterCommit: 1, contextStart: 201, summary: "frozen memory" },
  { afterCommit: 2, contextStart: 199, summary: "frozen memory" },
  { afterCommit: 2, contextStart: 201, summary: "frozen memory" },
  { afterCommit: 3, contextStart: 401, summary: "frozen memory" },
  { afterCommit: 4, contextStart: null, summary: "frozen memory" },
  { afterCommit: 5, contextStart: 201, summary: "frozen memory" },
  { afterCommit: 2, contextStart: 201, summary: null },
])(
  "test_legacy_history_resumes_without_orphans_when_interrupted_after_$afterCommit ($contextStart, $summary)",
  async (scenario) => {
    const key = { assistantId: 1, chatId: 42, threadKey: 0 };

    const runs = Array.from({ length: 401 }, (_, index) => {
      const messageId = index + 1;

      return {
        actions:
          messageId % 2 === 0
            ? []
            : [
                {
                  payload: { replyTo: messageId, text: `reply ${messageId}`, type: "text" },
                  telegramMessageId: 10_000 + messageId,
                },
              ],
        id: String(messageId),
        inputs: [
          {
            id: String(messageId),
            payload: {
              addressed: true,
              date: 1_700_000_000,
              editDate: null,
              forwardOrigin: null,
              forwardedFromSelf: false,
              media: [],
              mediaGroupId: null,
              messageId,
              repliedMedia: [],
              repliedText: null,
              replyToMessageId: null,
              senderFirstName: "Ann",
              senderId: 7,
              senderUsername: null,
              text: `message ${messageId}`,
            },
            senderUserId: null,
            updateId: messageId,
          },
        ],
        lastOrdinal: messageId,
        tools: [],
      };
    });

    // Prisma's proxy bypasses method spies; copy its bound methods before replacing the read boundary.
    const client = {
      ...new PrismaClient({ adapter: new PrismaPg({ connectionString: "postgresql://unused/unused" }) }),
    };

    const query = spyOn(client, "$queryRaw").mockResolvedValue(runs);

    const database = Database.Service.of({
      query: (operation) => Effect.promise(async () => await operation(client)),
      transaction: () => Effect.die(new Error("Import must not write legacy data")),
    });

    const options = {
      agent: { model: { modelId: "unused", provider: "unused" } },
      timing: { maxWaitMs: 0, quietMs: 0 },
    };

    const storage = new MemoryStorage();
    // Keep the store across harness lifetimes, like reopening the production database.
    const close = spyOn(storage, "close").mockResolvedValue(undefined);
    const harnessOptions = { models: createModels(), registry: createRegistry() };
    let harness = await Harness.open(storage, harnessOptions, BACKGROUND_CONTEXT);
    const commit = harness.commit.bind(harness);
    let commits = 0;
    const interrupted = new Error("Import interrupted");

    const interruption = spyOn(harness, "commit").mockImplementation(async (...args) => {
      const result = await commit(...args);
      commits += 1;

      if (commits === scenario.afterCommit) throw interrupted;

      return result;
    });

    const run = async () => {
      query.mockResolvedValueOnce([
        {
          assistantId: 1n,
          chatId: 42n,
          contextStart: scenario.contextStart,
          frozenMemory: scenario.summary,
          threadKey: 0,
        },
      ]);
      await Effect.runPromise(
        LegacyImport.run(harness, options).pipe(Effect.provideService(Database.Service, database)),
      );
    };

    try {
      // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- Bun rejects assertions are async at runtime but declared void
      await expect(run()).rejects.toMatchObject({ cause: interrupted });
      interruption.mockRestore();
      const before = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
      expect(before.items).toHaveLength(1);
      const conversationId = before.items[0]!.id;

      const partial = await storage.scanEntries(
        { conversationId, order: "ascending" },
        1000,
        undefined,
        BACKGROUND_CONTEXT,
      );

      await harness.close(BACKGROUND_CONTEXT);
      harness = await Harness.open(storage, harnessOptions, BACKGROUND_CONTEXT);
      await run();
      await run();

      const conversations = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
      expect(conversations.items.map((item) => item.id)).toEqual([conversationId]);
      expect(await harness.snapshot(LaneDoc.index, ConversationKey.format(key), BACKGROUND_CONTEXT)).toEqual({
        conversationId,
      });

      const entries = await storage.scanEntries(
        { conversationId, order: "ascending" },
        1000,
        undefined,
        BACKGROUND_CONTEXT,
      );

      expect(entries.items.slice(0, partial.items.length)).toEqual([...partial.items]);
      expect(entries.items.filter((entry) => entry.kind === "starlight.batch").map((entry) => entry.data)).toEqual(
        Array.from({ length: 401 }, (_, index) => ({ messageIds: [index + 1] })),
      );
      expect(entries.items.filter((entry) => entry.kind === "starlight.legacy-reply")).toHaveLength(201);
      const summaries = entries.items.filter((entry) => entry.kind === CompactionEntry.kind);
      expect(summaries).toHaveLength(scenario.summary === null ? 0 : 1);

      if (scenario.summary !== null) {
        const head =
          scenario.contextStart === null
            ? summaries[0]!.id
            : entries.items.find(
                (entry) =>
                  entry.kind === "starlight.batch" &&
                  JSON.stringify(entry.data) === JSON.stringify({ messageIds: [scenario.contextStart] }),
              )!.id;

        expect(summaries[0]!.head).toBe(head);
        expect(JSON.stringify(summaries[0]!.model)).toContain("frozen memory");
      }

      const lane = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);
      expect(lane!.key).toEqual(key);
      expect(lane!.pending).toEqual([]);
      expect(lane!.admittedKeys).toContain("update:401");
      expect(lane!.seenMessageIds.slice(-3)).toEqual([400, 401, 10_401]);
      expect(lane!.recentReplies).toEqual([387, 389, 391, 393, 395, 397, 399, 401].map((id) => `reply ${id}`));
    } finally {
      interruption.mockRestore();
      await harness.close(BACKGROUND_CONTEXT);
      close.mockRestore();
      await storage.close(BACKGROUND_CONTEXT);
      query.mockRestore();
      await client.$disconnect();
    }
  },
);

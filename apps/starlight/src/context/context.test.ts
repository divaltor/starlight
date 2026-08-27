import { expect, test } from "bun:test";
import type { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ChatTools } from "@/ai/chat-tools";
import { Model } from "@/ai/model";
import { ConversationContext } from "@/context/context";
import { Prompt } from "@/context/prompt";
import { Media } from "@/media/media";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;

// Each test owns an isolated assistant/chat pair; clearing every conversation row for the
// pair keeps runs independent of execution order.
async function clearConversation(client: PrismaClient, assistantId: bigint, chatId: bigint) {
  const where = { assistantId, chatId };
  await client.conversationCheckpointAttempt.deleteMany({ where: { parentContext: where } });
  await client.conversationRun.updateMany({ where, data: { contextId: null } });
  await client.conversationContext.deleteMany({ where });
  await client.conversationTranscriptTurn.deleteMany({ where });
  await client.conversationRun.deleteMany({ where });
  await client.memoryNamespace.deleteMany({ where: { chatId } });
  await client.conversationInput.deleteMany({ where });
  await client.conversationLane.deleteMany({ where });
  await client.chat.deleteMany({ where: { id: chatId } });
}

test.skipIf(!databaseUrl)("repeated finalization appends one immutable attributed context sequence", async () => {
  const runtime = ManagedRuntime.make(
    ConversationContext.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Database.layer(databaseUrl!),
          Layer.succeed(ChatTools.Service)(disabledChatTools),
          Layer.succeed(Model.Service)(unavailableModel),
          mediaLayer,
        ),
      ),
    ),
  );
  const assistantId = 8_000_000_092n;
  const chatId = -8_000_000_092n;
  let runId = "";

  try {
    await runtime.runPromise(
      Effect.gen(function* verifyContextAppend() {
        const context = yield* ConversationContext.Service;
        const database = yield* Database.Service;
        runId = yield* database.query(async (client) => {
          await clearConversation(client, assistantId, chatId);
          await client.chat.create({ data: { id: chatId } });
          await client.conversationLane.create({
            data: {
              assistantId,
              chatId,
              pendingRevision: 1,
              processedRevision: 1,
              threadKey: 0,
            },
          });
          const input = await client.conversationInput.create({
            data: {
              admittedRevision: 1,
              assistantId,
              chatId,
              payload: {
                addressed: true,
                date: 1_700_000_000,
                editDate: null,
                forwardOrigin: null,
                messageId: 51,
                repliedText: null,
                replyToMessageId: null,
                senderFirstName: "Alice",
                senderId: 42,
                senderUsername: "alice",
                text: "Hello",
              },
              senderTelegramId: 42n,
              sourceMessageId: 51,
              sourceRevision: "51:1700000000",
              sourceUpdateId: 101,
              threadKey: 0,
            },
          });
          const run = await client.conversationRun.create({
            data: {
              actions: {
                create: {
                  deliveryStatus: "delivered",
                  ordinal: 0,
                  payload: { replyTo: 51, text: "Hi", type: "text" },
                  targetMessageId: 51,
                  type: "text",
                },
              },
              assistantId,
              chatId,
              eligibilityReason: "direct",
              fencingToken: 1n,
              finalizedAt: new Date(),
              inputEndRevision: 1,
              inputStartRevision: 1,
              inputs: { create: { inputId: input.id, ordinal: 0 } },
              modelProfileFingerprint: new Bun.CryptoHasher("sha256")
                .update(Prompt.renderEnvelope({ toolProfile: [] }))
                .digest("hex"),
              replyEligible: true,
              status: "finalized",
              threadKey: 0,
            },
          });
          await client.conversationLane.update({
            where: {
              assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 },
            },
            data: { activeRunId: run.id, fencingToken: 1n },
          });
          return run.id;
        });

        const first = yield* context.appendFinalized({ fencingToken: 1n, runId });
        const repeated = yield* context.appendFinalized({ fencingToken: 1n, runId });
        const counts = yield* database.query(async (client) => ({
          contextTurns: await client.conversationContextTurn.count({
            where: { contextId: first.contextId },
          }),
          memoryObservations: await client.memoryObservation.findMany({
            where: { sourceRunId: runId },
            orderBy: { namespace: { kind: "asc" } },
            select: { content: true },
          }),
          transcriptTurns: await client.conversationTranscriptTurn.count({
            where: { runId },
          }),
        }));

        expect(first.appendedTurns).toBe(2);
        expect(repeated.appendedTurns).toBe(0);
        expect(repeated.terminalPrefixHash).toBe(first.terminalPrefixHash);
        expect(counts.contextTurns).toBe(2);
        expect(counts.memoryObservations).toEqual([
          {
            content: {
              addressed: true,
              author: {
                firstName: "Alice",
                isBot: false,
                lastName: null,
                username: "alice",
              },
              messageId: 51,
              reply: null,
              text: "Hello",
            },
          },
          {
            content: {
              addressed: true,
              author: {
                firstName: "Alice",
                isBot: false,
                lastName: null,
                username: "alice",
              },
              messageId: 51,
              reply: null,
              text: "Hello",
            },
          },
        ]);
        expect(counts.transcriptTurns).toBe(2);
      }),
    );
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => clearConversation(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)("a prepared run transitions profile while preserving retained turns", async () => {
  const runtime = ManagedRuntime.make(
    ConversationContext.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Database.layer(databaseUrl!),
          Layer.succeed(ChatTools.Service)(disabledChatTools),
          Layer.succeed(Model.Service)(unavailableModel),
          mediaLayer,
        ),
      ),
    ),
  );
  const assistantId = 8_000_000_093n;
  const chatId = -8_000_000_093n;
  const retainedRenderedContent = '<message role="user">retained bytes</message>';
  const retainedRenderVersion = "conversation-context-v1";

  try {
    await runtime.runPromise(
      Effect.gen(function* transitionProfile() {
        const context = yield* ConversationContext.Service;
        const database = yield* Database.Service;
        const runId = yield* database.query(async (client) => {
          await clearConversation(client, assistantId, chatId);
          await client.chat.create({ data: { id: chatId } });
          await client.conversationLane.create({
            data: {
              assistantId,
              chatId,
              pendingRevision: 1,
              processedRevision: 0,
              threadKey: 0,
            },
          });
          const parent = await client.conversationContext.create({
            data: {
              activeKey: `v1/${assistantId}/${chatId}/0`,
              assistantId,
              basePrefixHash: "obsolete-base",
              chatId,
              estimatedStableTokens: 1,
              frozenMemory: Prompt.renderMemory({ checkpoint: "", scopes: [] }),
              frozenMemoryHash: "obsolete-memory",
              generation: 1,
              modelProfileFingerprint: "obsolete-profile",
              stableEnvelope: Prompt.renderEnvelope({ toolProfile: [] }),
              stableEnvelopeHash: "obsolete-envelope",
              threadKey: 0,
            },
          });
          const run = await client.conversationRun.create({
            data: {
              assistantId,
              chatId,
              eligibilityReason: "profile-transition-test",
              fencingToken: 1n,
              inputEndRevision: 1,
              inputStartRevision: 1,
              modelProfileFingerprint: Prompt.profileFingerprint([]),
              replyEligible: false,
              threadKey: 0,
            },
          });
          const transcriptTurn = await client.conversationTranscriptTurn.create({
            data: {
              assistantId,
              chatId,
              content: { text: "Retained" },
              idempotencyKey: `${run.id}:retained`,
              kind: "userMessage",
              ordinal: 1,
              runId: run.id,
              sourceReferences: {},
              threadKey: 0,
              visibility: "conversation",
            },
          });
          await client.conversationContextTurn.create({
            data: {
              contextId: parent.id,
              estimatedTokens: 2,
              ordinal: 1,
              renderedContent: retainedRenderedContent,
              renderVersion: retainedRenderVersion,
              role: "user",
              rollingPrefixHash: "obsolete-rolling",
              segmentHash: "obsolete-segment",
              transcriptTurnId: transcriptTurn.id,
            },
          });
          await client.conversationLane.update({
            where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
            data: { activeContextId: parent.id, activeRunId: run.id, fencingToken: 1n },
          });
          return run.id;
        });

        const transitioned = yield* context.transitionProfile({
          key: { assistantId: Number(assistantId), chatId: Number(chatId), threadKey: 0 },
          reason: "profile-change",
          run: { fencingToken: 1n, runId },
          toolProfile: [],
        });
        const persisted = yield* database.query(async (client) => ({
          contexts: await client.conversationContext.findMany({
            where: { assistantId, chatId },
            orderBy: { generation: "asc" },
          }),
          run: await client.conversationRun.findUniqueOrThrow({ where: { id: runId } }),
          turns: await client.conversationContextTurn.findMany({
            where: { contextId: transitioned.id },
            orderBy: { ordinal: "asc" },
          }),
        }));

        expect(transitioned.generation).toBe(2);
        expect(persisted.contexts.map((item) => item.status)).toEqual(["superseded", "active"]);
        expect(persisted.run.contextId).toBe(transitioned.id);
        expect(transitioned.profileFingerprint).toBe(Prompt.profileFingerprint([]));
        expect(
          persisted.turns.map((turn) => ({
            renderedContent: turn.renderedContent,
            renderVersion: turn.renderVersion,
          })),
        ).toEqual([{ renderedContent: retainedRenderedContent, renderVersion: retainedRenderVersion }]);
      }),
    );
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => clearConversation(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)("a frozen request that can no longer be reproduced fails permanently", async () => {
  const runtime = ManagedRuntime.make(
    ConversationContext.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Database.layer(databaseUrl!),
          Layer.succeed(ChatTools.Service)(disabledChatTools),
          Layer.succeed(Model.Service)(unavailableModel),
          mediaLayer,
        ),
      ),
    ),
  );
  const assistantId = 8_000_000_100n;
  const chatId = -8_000_000_100n;
  let runId = "";

  try {
    await runtime.runPromise(
      Effect.gen(function* seedFrozenRun() {
        const context = yield* ConversationContext.Service;
        const database = yield* Database.Service;
        runId = yield* database.query(async (client) => {
          await clearConversation(client, assistantId, chatId);
          await client.chat.create({ data: { id: chatId } });
          await client.conversationLane.create({
            data: { assistantId, chatId, pendingRevision: 1, processedRevision: 1, threadKey: 0 },
          });
          const input = await client.conversationInput.create({
            data: {
              admittedRevision: 1,
              assistantId,
              chatId,
              payload: {
                addressed: true,
                date: 1_700_000_000,
                editDate: null,
                forwardOrigin: null,
                messageId: 61,
                repliedText: null,
                replyToMessageId: null,
                senderFirstName: "Alice",
                senderId: 42,
                senderUsername: "alice",
                text: "Hello",
              },
              senderTelegramId: 42n,
              sourceMessageId: 61,
              sourceRevision: "original:61",
              sourceUpdateId: 161,
              threadKey: 0,
            },
          });
          const run = await client.conversationRun.create({
            data: {
              assistantId,
              chatId,
              eligibilityReason: "frozen-hash-test",
              fencingToken: 1n,
              inputEndRevision: 1,
              inputStartRevision: 1,
              inputs: { create: { inputId: input.id, ordinal: 0 } },
              modelProfileFingerprint: Prompt.profileFingerprint([]),
              preparedRequest: {
                contextMemory: null,
                currentDate: "2026-08-24",
                sessionId: "frozen-hash-session",
                toolProfile: [],
                userMemory: [],
              },
              replyEligible: true,
              status: "invoking",
              threadKey: 0,
            },
          });
          await client.conversationLane.update({
            where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
            data: { activeRunId: run.id, fencingToken: 1n },
          });
          return run.id;
        });

        // Freeze the request, then corrupt the stored hash the way an unversioned rendering
        // change between freeze and replay would.
        yield* context.appendFinalized({ fencingToken: 1n, runId });
        yield* database.query((client) =>
          client.conversationRun.update({ where: { id: runId }, data: { requestHash: "stale-hash" } }),
        );
      }),
    );

    // Regression: a hash mismatch must be permanent. Marked retryable it would redrive
    // forever because attemptCount only advances during model invocation.
    await expect(
      runtime.runPromise(
        Effect.gen(function* reprepareFrozenRun() {
          const context = yield* ConversationContext.Service;
          return yield* context.prepare({ fencingToken: 1n, runId });
        }),
      ),
    ).rejects.toMatchObject({ retryable: false });
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query((client) => clearConversation(client, assistantId, chatId));
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)(
  "test_projects_linked_reply_context_once_when_two_runs_reply_to_the_same_unadmitted_target",
  async () => {
    const runtime = ManagedRuntime.make(
      ConversationContext.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Database.layer(databaseUrl!),
            Layer.succeed(ChatTools.Service)(disabledChatTools),
            Layer.succeed(Model.Service)(unavailableModel),
            mediaLayer,
          ),
        ),
      ),
    );
    const assistantId = 8_000_000_101n;
    const chatId = -8_000_000_101n;

    try {
      await runtime.runPromise(
        Effect.gen(function* verifyLinkedReplyDedup() {
          const context = yield* ConversationContext.Service;
          const database = yield* Database.Service;
          const runIds = yield* database.query(async (client) => {
            await clearConversation(client, assistantId, chatId);
            await client.chat.create({ data: { id: chatId } });
            await client.conversationLane.create({
              data: { assistantId, chatId, pendingRevision: 2, processedRevision: 2, threadKey: 0 },
            });
            const replyPayloadA = {
              addressed: true,
              date: 1_700_000_100,
              editDate: null,
              forwardOrigin: null,
              messageId: 71,
              repliedText: "sunset photo",
              replyToMessageId: 70,
              senderFirstName: "Alice",
              senderId: 42,
              senderUsername: "alice",
              text: "what is this?",
            };
            const replyPayloadB = { ...replyPayloadA, messageId: 72, text: "and now this?" };
            const inputA = await client.conversationInput.create({
              data: {
                admittedRevision: 1,
                assistantId,
                chatId,
                payload: replyPayloadA,
                senderTelegramId: 42n,
                sourceMessageId: 71,
                sourceRevision: "original:71",
                sourceUpdateId: 171,
                threadKey: 0,
              },
            });
            const inputB = await client.conversationInput.create({
              data: {
                admittedRevision: 2,
                assistantId,
                chatId,
                payload: replyPayloadB,
                senderTelegramId: 42n,
                sourceMessageId: 72,
                sourceRevision: "original:72",
                sourceUpdateId: 172,
                threadKey: 0,
              },
            });
            const runA = await client.conversationRun.create({
              data: {
                actions: {
                  create: {
                    deliveryStatus: "delivered",
                    ordinal: 0,
                    payload: { replyTo: 71, text: "A sunset", type: "text" },
                    targetMessageId: 71,
                    type: "text",
                  },
                },
                assistantId,
                chatId,
                eligibilityReason: "direct",
                fencingToken: 1n,
                finalizedAt: new Date(),
                inputEndRevision: 1,
                inputStartRevision: 1,
                inputs: { create: { inputId: inputA.id, ordinal: 0 } },
                modelProfileFingerprint: Prompt.profileFingerprint([]),
                replyEligible: true,
                status: "finalized",
                threadKey: 0,
              },
            });
            const runB = await client.conversationRun.create({
              data: {
                actions: {
                  create: {
                    deliveryStatus: "delivered",
                    ordinal: 0,
                    payload: { replyTo: 72, text: "Also a sunset", type: "text" },
                    targetMessageId: 72,
                    type: "text",
                  },
                },
                assistantId,
                chatId,
                eligibilityReason: "direct",
                fencingToken: 2n,
                finalizedAt: new Date(),
                inputEndRevision: 2,
                inputStartRevision: 2,
                inputs: { create: { inputId: inputB.id, ordinal: 0 } },
                modelProfileFingerprint: Prompt.profileFingerprint([]),
                replyEligible: true,
                status: "finalized",
                threadKey: 0,
              },
            });
            return { runA: runA.id, runB: runB.id };
          });

          yield* database.query(async (client) => {
            await client.conversationLane.update({
              where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
              data: { activeRunId: runIds.runA, fencingToken: 1n },
            });
          });
          const first = yield* context.appendFinalized({ fencingToken: 1n, runId: runIds.runA });
          yield* database.query(async (client) => {
            await client.conversationLane.update({
              where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
              data: { activeRunId: runIds.runB, fencingToken: 2n },
            });
          });
          const second = yield* context.appendFinalized({ fencingToken: 2n, runId: runIds.runB });
          const turns = yield* database.query(async (client) => ({
            linkedCount: await client.conversationTranscriptTurn.count({
              where: { assistantId, chatId, kind: "linkedReplyContext" },
            }),
            runATurns: await client.conversationTranscriptTurn.findMany({
              where: { runId: runIds.runA },
              orderBy: { ordinal: "asc" },
            }),
            runBTurns: await client.conversationTranscriptTurn.findMany({
              where: { runId: runIds.runB },
              orderBy: { ordinal: "asc" },
            }),
          }));

          expect(first.appendedTurns).toBe(3);
          expect(second.appendedTurns).toBe(2);
          expect(turns.runATurns.map((turn) => turn.kind)).toEqual([
            "linkedReplyContext",
            "userMessage",
            "assistantMessage",
          ]);
          expect(turns.runATurns.at(0)?.sourceMessageId).toBe(70);
          expect(turns.runBTurns.map((turn) => turn.kind)).toEqual(["userMessage", "assistantMessage"]);
          expect(turns.linkedCount).toBe(1);
        }),
      );
    } finally {
      await runtime.runPromise(
        Effect.gen(function* cleanup() {
          const database = yield* Database.Service;
          yield* database.query((client) => clearConversation(client, assistantId, chatId));
        }),
      );
      await runtime.dispose();
    }
  },
);

const disabledChatTools: ChatTools.Interface = {
  availableProfile: [],
  resolve: (profile) => Effect.succeed({ profile, tools: {} }),
};

const mediaLayer = Layer.succeed(Media.Service)({
  ingest: (source) =>
    Effect.succeed({
      availability: "unavailable",
      mimeType: source.mimeType,
      reason: "not used in context tests",
      stableDescription: "media unavailable in context tests",
      telegramFileId: source.telegramFileId,
      telegramFileUniqueId: source.telegramFileUniqueId,
      type: source.type,
    }),
  load: () => Effect.succeed(null),
});

const unavailableModel: Model.Interface = {
  generate: () => Effect.die(new Error("Model must not run while appending context")),
};

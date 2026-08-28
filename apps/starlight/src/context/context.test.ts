import { expect, test } from "bun:test";
import type { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Effect, Layer, Logger, ManagedRuntime, References } from "effect";
import { ChatTools } from "@/ai/chat-tools";
import { Model } from "@/ai/model";
import { Usage } from "@/ai/usage";
import { ConversationContext } from "@/context/context";
import { Prompt } from "@/context/prompt";
import { Media } from "@/media/media";
import { Database } from "@/services/database";

const databaseUrl = process.env.DATABASE_URL;
const FROZEN_PROFILE_ENVELOPE = Prompt.canonicalEncode({
  instructions: "Frozen profile instructions",
  tools: [],
  version: "profile-envelope-test-v1",
});

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
              author: {
                firstName: "Alice",
                isBot: false,
                lastName: null,
                username: "alice",
              },
              messageId: 51,
              reply: null,
              text: "Hello",
              timestamp: "2023-11-14T22:13:20.000Z",
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
  const profileEnvelope = FROZEN_PROFILE_ENVELOPE;

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
              modelProfileFingerprint: new Bun.CryptoHasher("sha256").update(profileEnvelope).digest("hex"),
              preparedRequest: { profileEnvelope, toolProfile: [] },
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
          leaseMs: 180_000,
          profileEnvelope,
          reason: "profile-change",
          retainedTokenTarget: 6000,
          telemetryPrivate: false,
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
        expect(transitioned.profileFingerprint).toBe(
          new Bun.CryptoHasher("sha256").update(profileEnvelope).digest("hex"),
        );
        expect(transitioned.summarized).toBe(false);
        expect(persisted.contexts.at(-1)?.stableEnvelope).toBe(profileEnvelope);
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

test.skipIf(!databaseUrl)("a profile change summarizes old runs and retains the newest eight", async () => {
  let summaryAttempts = 0;
  const retryingSummaryModel: Model.Interface = {
    generate: (input) => {
      summaryAttempts += 1;
      if (summaryAttempts === 1) {
        return Effect.fail(new Model.Unavailable({ message: "Interrupted profile summary", retryable: true }));
      }
      return Effect.succeed({
        finishReason: "stop",
        output: input.outputSchema.parse({ summary: "Condensed conversation history" }),
        steps: [],
        toolEvents: [],
        transcript: [],
        usage: Usage.aggregate([]),
      });
    },
  };
  const runtime = ManagedRuntime.make(
    ConversationContext.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Database.layer(databaseUrl!),
          Layer.succeed(ChatTools.Service)(disabledChatTools),
          Layer.succeed(Model.Service)(retryingSummaryModel),
          mediaLayer,
        ),
      ),
    ),
  );
  const assistantId = 8_000_000_105n;
  const chatId = -8_000_000_105n;
  const profileEnvelope = FROZEN_PROFILE_ENVELOPE;
  const obsoleteEnvelope = "obsolete-profile-envelope";

  try {
    await runtime.runPromise(
      Effect.gen(function* transitionProfileWithSummary() {
        const context = yield* ConversationContext.Service;
        const database = yield* Database.Service;
        const seeded = yield* database.query(async (client) => {
          await clearConversation(client, assistantId, chatId);
          await client.chat.create({ data: { id: chatId } });
          await client.conversationLane.create({
            data: {
              assistantId,
              chatId,
              pendingRevision: 11,
              processedRevision: 10,
              threadKey: 0,
            },
          });
          const parent = await client.conversationContext.create({
            data: {
              activeKey: `v1/${assistantId}/${chatId}/0`,
              assistantId,
              chatId,
              generation: 1,
              modelProfileFingerprint: new Bun.CryptoHasher("sha256").update(obsoleteEnvelope).digest("hex"),
              threadKey: 0,
              ...Prompt.stableSeed(obsoleteEnvelope, Prompt.renderMemory({ checkpoint: "", scopes: [] })),
            },
          });
          let summarizedThroughInputSequence = 0n;
          for (const index of Array.from({ length: 10 }, (_, item) => item + 1)) {
            const input = await client.conversationInput.create({
              data: {
                admittedRevision: index,
                assistantId,
                chatId,
                payload: {
                  addressed: true,
                  date: 1_700_000_000 + index,
                  editDate: null,
                  forwardOrigin: null,
                  messageId: 100 + index,
                  repliedText: null,
                  replyToMessageId: null,
                  senderFirstName: "Alice",
                  senderId: 42,
                  senderUsername: "alice",
                  text: `Message ${index}`,
                },
                senderTelegramId: 42n,
                sourceMessageId: 100 + index,
                sourceRevision: `original:${100 + index}`,
                sourceUpdateId: 200 + index,
                threadKey: 0,
              },
            });
            const run = await client.conversationRun.create({
              data: {
                assistantId,
                chatId,
                eligibilityReason: "profile-checkpoint-history",
                fencingToken: 1n,
                finalizedAt: new Date(),
                inputEndRevision: index,
                inputStartRevision: index,
                inputs: { create: { inputId: input.id, ordinal: 0 } },
                modelProfileFingerprint: new Bun.CryptoHasher("sha256").update(obsoleteEnvelope).digest("hex"),
                replyEligible: true,
                status: "finalized",
                threadKey: 0,
              },
            });
            const transcriptTurn = await client.conversationTranscriptTurn.create({
              data: {
                assistantId,
                chatId,
                content: { text: `Message ${index}` },
                idempotencyKey: `${run.id}:user`,
                kind: "userMessage",
                ordinal: index,
                runId: run.id,
                sourceMessageId: 100 + index,
                sourceReferences: {},
                threadKey: 0,
                visibility: "conversation",
              },
            });
            await client.conversationContextTurn.create({
              data: {
                contextId: parent.id,
                estimatedTokens: 100,
                ordinal: index,
                renderedContent: `turn-${index}`,
                renderVersion: "profile-checkpoint-test-v1",
                role: "user",
                rollingPrefixHash: `obsolete-rolling-${index}`,
                segmentHash: `obsolete-segment-${index}`,
                transcriptTurnId: transcriptTurn.id,
              },
            });
            if (index === 2) summarizedThroughInputSequence = input.id;
          }
          const currentRun = await client.conversationRun.create({
            data: {
              assistantId,
              chatId,
              eligibilityReason: "profile-checkpoint-current",
              fencingToken: 1n,
              inputEndRevision: 11,
              inputStartRevision: 11,
              modelProfileFingerprint: new Bun.CryptoHasher("sha256").update(profileEnvelope).digest("hex"),
              preparedRequest: { profileEnvelope, toolProfile: [] },
              replyEligible: true,
              threadKey: 0,
            },
          });
          await client.conversationLane.update({
            where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
            data: { activeContextId: parent.id, activeRunId: currentRun.id, fencingToken: 1n },
          });
          return { runId: currentRun.id, summarizedThroughInputSequence };
        });

        const firstAttempt = yield* Effect.result(
          context.transitionProfile({
            key: { assistantId: Number(assistantId), chatId: Number(chatId), threadKey: 0 },
            leaseMs: 180_000,
            profileEnvelope,
            reason: "profile-change",
            retainedTokenTarget: 6000,
            telemetryPrivate: false,
            run: { fencingToken: 1n, runId: seeded.runId },
            toolProfile: [],
          }),
        );
        expect(firstAttempt._tag).toBe("Failure");
        yield* database.query(async (client) => {
          await client.conversationRun.update({ where: { id: seeded.runId }, data: { fencingToken: 2n } });
          await client.conversationLane.update({
            where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
            data: { fencingToken: 2n },
          });
        });
        const transitioned = yield* context.transitionProfile({
          key: { assistantId: Number(assistantId), chatId: Number(chatId), threadKey: 0 },
          leaseMs: 180_000,
          profileEnvelope,
          reason: "profile-change",
          retainedTokenTarget: 6000,
          telemetryPrivate: false,
          run: { fencingToken: 2n, runId: seeded.runId },
          toolProfile: [],
        });
        const persisted = yield* database.query(async (client) => ({
          attempts: await client.conversationCheckpointAttempt.findMany({
            where: { runId: seeded.runId },
          }),
          child: await client.conversationContext.findUniqueOrThrow({ where: { id: transitioned.id } }),
          run: await client.conversationRun.findUniqueOrThrow({ where: { id: seeded.runId } }),
          turns: await client.conversationContextTurn.findMany({
            where: { contextId: transitioned.id },
            include: { transcriptTurn: true },
            orderBy: { ordinal: "asc" },
          }),
        }));

        expect(transitioned.summarized).toBe(true);
        expect(summaryAttempts).toBe(2);
        expect(persisted.attempts).toHaveLength(1);
        expect(persisted.attempts[0]).toMatchObject({ reason: "profileChange", status: "committed" });
        expect(persisted.child.stableEnvelope).toBe(profileEnvelope);
        expect(persisted.child.frozenMemory).toBe(
          Prompt.renderMemory({ checkpoint: "Condensed conversation history", scopes: [] }),
        );
        expect(persisted.child.summaryThroughInputSequence).toBe(seeded.summarizedThroughInputSequence);
        expect(persisted.run.contextId).toBe(transitioned.id);
        expect(persisted.turns.map((turn) => turn.transcriptTurn.ordinal)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);

        const repeated = yield* context.transitionProfile({
          key: { assistantId: Number(assistantId), chatId: Number(chatId), threadKey: 0 },
          leaseMs: 180_000,
          profileEnvelope,
          reason: "profile-change",
          retainedTokenTarget: 6000,
          telemetryPrivate: false,
          run: { fencingToken: 2n, runId: seeded.runId },
          toolProfile: [],
        });
        expect(repeated).toMatchObject({ id: transitioned.id, summarized: false });
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
                profileEnvelope: Prompt.renderEnvelope({ toolProfile: [] }),
                sessionId: "frozen-hash-session",
                toolProfile: [],
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

test.skipIf(!databaseUrl)("reports_append_only_when_a_sealed_turn_replaces_its_live_form", async () => {
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
  const assistantId = 8_000_000_102n;
  const chatId = -8_000_000_102n;
  const verdicts: { annotations: object; message: unknown }[] = [];
  const collector = Logger.formatStructured.pipe(
    Logger.map((output) => verdicts.push({ annotations: output.annotations, message: output.message })),
  );
  let runAId = "";
  let runBId = "";

  try {
    await runtime.runPromise(
      Effect.gen(function* verifySealedPrefixIsAppendOnly() {
        const context = yield* ConversationContext.Service;
        const database = yield* Database.Service;
        const ids = yield* database.query(async (client) => {
          await clearConversation(client, assistantId, chatId);
          await client.chat.create({ data: { id: chatId } });
          await client.conversationLane.create({
            data: { assistantId, chatId, pendingRevision: 1, processedRevision: 1, threadKey: 0 },
          });
          const inputA = await client.conversationInput.create({
            data: {
              admittedRevision: 1,
              assistantId,
              chatId,
              payload: {
                addressed: true,
                date: 1_700_000_000,
                editDate: null,
                forwardOrigin: null,
                messageId: 71,
                repliedText: null,
                replyToMessageId: null,
                senderFirstName: "Alice",
                senderId: 42,
                senderUsername: "alice",
                text: "Hello",
              },
              senderTelegramId: 42n,
              sourceMessageId: 71,
              sourceRevision: "71:1700000000",
              sourceUpdateId: 171,
              threadKey: 0,
            },
          });
          const runA = await client.conversationRun.create({
            data: {
              actions: {
                create: {
                  deliveryStatus: "delivered",
                  ordinal: 0,
                  payload: { replyTo: 71, text: "Hi", type: "text" },
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
              preparedRequest: {
                contextMemory: null,
                currentDate: "2026-08-28",
                profileEnvelope: Prompt.renderEnvelope({ toolProfile: [] }),
                sessionId: "cache-prefix-session-a",
                toolProfile: [],
              },
              replyEligible: true,
              status: "finalized",
              threadKey: 0,
            },
          });
          const inputB = await client.conversationInput.create({
            data: {
              admittedRevision: 2,
              assistantId,
              chatId,
              payload: {
                addressed: true,
                date: 1_700_000_100,
                editDate: null,
                forwardOrigin: null,
                messageId: 72,
                repliedText: null,
                replyToMessageId: null,
                senderFirstName: "Alice",
                senderId: 42,
                senderUsername: "alice",
                text: "Follow-up",
              },
              senderTelegramId: 42n,
              sourceMessageId: 72,
              sourceRevision: "72:1700000100",
              sourceUpdateId: 172,
              threadKey: 0,
            },
          });
          const runB = await client.conversationRun.create({
            data: {
              assistantId,
              chatId,
              eligibilityReason: "direct",
              fencingToken: 2n,
              inputEndRevision: 2,
              inputStartRevision: 2,
              inputs: { create: { inputId: inputB.id, ordinal: 0 } },
              modelProfileFingerprint: Prompt.profileFingerprint([]),
              preparedRequest: {
                contextMemory: null,
                currentDate: "2026-08-28",
                profileEnvelope: Prompt.renderEnvelope({ toolProfile: [] }),
                sessionId: "cache-prefix-session-b",
                toolProfile: [],
              },
              replyEligible: true,
              status: "invoking",
              threadKey: 0,
            },
          });
          await client.conversationLane.update({
            where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
            data: { activeRunId: runA.id, fencingToken: 1n },
          });
          return { runA: runA.id, runB: runB.id };
        });
        runAId = ids.runA;
        runBId = ids.runB;

        yield* context.prepare({ fencingToken: 1n, runId: runAId });
        yield* context.appendFinalized({ fencingToken: 1n, runId: runAId });
        const contextId = yield* database.query(async (client) => {
          const runA = await client.conversationRun.findUniqueOrThrow({ where: { id: runAId } });
          await client.conversationRun.update({ where: { id: runBId }, data: { contextId: runA.contextId } });
          await client.conversationLane.update({
            where: { assistantId_chatId_threadKey: { assistantId, chatId, threadKey: 0 } },
            data: { activeRunId: runBId, fencingToken: 2n },
          });
          return runA.contextId;
        });
        expect(contextId).not.toBeNull();

        yield* context.prepare({ fencingToken: 2n, runId: runBId });
      }).pipe(
        // The verdict is logged at debug level, which the default minimum filters out.
        Effect.provide(Logger.layer([collector])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    );

    const compared = verdicts.filter((entry) => entry.message === "Prepared context prefix compared");
    expect(compared.at(-1)?.annotations).toMatchObject({
      appendedMessages: 2,
      messageCount: 2,
      previousMessageCount: 0,
      status: "append-only",
    });
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

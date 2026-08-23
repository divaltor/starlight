import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as Model from "@/ai/model";
import * as ConversationContext from "@/context/context";
import * as Prompt from "@/context/prompt";
import * as Database from "@/services/database";
import * as Exa from "@/services/exa";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)("repeated finalization appends one immutable context sequence", async () => {
  const runtime = ManagedRuntime.make(
    ConversationContext.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Database.layer(databaseUrl!),
          Layer.succeed(Exa.Service)(disabledExa),
          Layer.succeed(Model.Service)(unavailableModel),
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
          await client.conversationCheckpointAttempt.deleteMany({
            where: { parentContext: { assistantId, chatId } },
          });
          await client.conversationRun.updateMany({
            where: { assistantId, chatId },
            data: { contextId: null },
          });
          await client.conversationContext.deleteMany({ where: { assistantId, chatId } });
          await client.conversationTranscriptTurn.deleteMany({
            where: { assistantId, chatId },
          });
          await client.conversationRun.deleteMany({ where: { assistantId, chatId } });
          await client.conversationInput.deleteMany({ where: { assistantId, chatId } });
          await client.conversationLane.deleteMany({ where: { assistantId, chatId } });
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
                .update(Prompt.renderEnvelope({ webLookupEnabled: false }))
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
          transcriptTurns: await client.conversationTranscriptTurn.count({
            where: { runId },
          }),
        }));

        expect(first.appendedTurns).toBe(2);
        expect(repeated.appendedTurns).toBe(0);
        expect(repeated.terminalPrefixHash).toBe(first.terminalPrefixHash);
        expect(counts.contextTurns).toBe(2);
        expect(counts.transcriptTurns).toBe(2);
      }),
    );
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query(async (client) => {
          await client.conversationCheckpointAttempt.deleteMany({
            where: { parentContext: { assistantId, chatId } },
          });
          await client.conversationRun.updateMany({
            where: { assistantId, chatId },
            data: { contextId: null },
          });
          await client.conversationContext.deleteMany({ where: { assistantId, chatId } });
          await client.conversationTranscriptTurn.deleteMany({ where: { assistantId, chatId } });
          await client.conversationRun.deleteMany({ where: { assistantId, chatId } });
          await client.conversationInput.deleteMany({ where: { assistantId, chatId } });
          await client.conversationLane.deleteMany({ where: { assistantId, chatId } });
        });
      }),
    );
    await runtime.dispose();
  }
});

test.skipIf(!databaseUrl)("a prepared run transitions to the configured context profile", async () => {
  const runtime = ManagedRuntime.make(
    ConversationContext.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Database.layer(databaseUrl!),
          Layer.succeed(Exa.Service)(disabledExa),
          Layer.succeed(Model.Service)(unavailableModel),
        ),
      ),
    ),
  );
  const assistantId = 8_000_000_093n;
  const chatId = -8_000_000_093n;

  try {
    await runtime.runPromise(
      Effect.gen(function* transitionProfile() {
        const context = yield* ConversationContext.Service;
        const database = yield* Database.Service;
        const runId = yield* database.query(async (client) => {
          const where = { assistantId, chatId };
          await client.conversationCheckpointAttempt.deleteMany({ where: { parentContext: where } });
          await client.conversationRun.updateMany({ where, data: { contextId: null } });
          await client.conversationContext.deleteMany({ where });
          await client.conversationTranscriptTurn.deleteMany({ where });
          await client.conversationRun.deleteMany({ where });
          await client.conversationInput.deleteMany({ where });
          await client.conversationLane.deleteMany({ where });
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
              frozenMemory: Prompt.renderMemory(""),
              frozenMemoryHash: "obsolete-memory",
              generation: 1,
              modelProfileFingerprint: "obsolete-profile",
              stableEnvelope: Prompt.renderEnvelope({ webLookupEnabled: false }),
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
              modelProfileFingerprint: Prompt.profileFingerprint(false),
              replyEligible: false,
              threadKey: 0,
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
          webLookupEnabled: false,
        });
        const persisted = yield* database.query(async (client) => ({
          contexts: await client.conversationContext.findMany({
            where: { assistantId, chatId },
            orderBy: { generation: "asc" },
          }),
          run: await client.conversationRun.findUniqueOrThrow({ where: { id: runId } }),
        }));

        expect(transitioned.generation).toBe(2);
        expect(persisted.contexts.map((item) => item.status)).toEqual(["superseded", "active"]);
        expect(persisted.run.contextId).toBe(transitioned.id);
        expect(transitioned.profileFingerprint).toBe(Prompt.profileFingerprint(false));
      }),
    );
  } finally {
    await runtime.runPromise(
      Effect.gen(function* cleanup() {
        const database = yield* Database.Service;
        yield* database.query(async (client) => {
          const where = { assistantId, chatId };
          await client.conversationCheckpointAttempt.deleteMany({ where: { parentContext: where } });
          await client.conversationRun.updateMany({ where, data: { contextId: null } });
          await client.conversationContext.deleteMany({ where });
          await client.conversationTranscriptTurn.deleteMany({ where });
          await client.conversationRun.deleteMany({ where });
          await client.conversationInput.deleteMany({ where });
          await client.conversationLane.deleteMany({ where });
        });
      }),
    );
    await runtime.dispose();
  }
});

const disabledExa: Exa.Interface = {
  isEnabled: () => false,
  lookup: () => Effect.succeed(null),
  search: () => Effect.succeed([]),
};

const unavailableModel: Model.Interface = {
  generate: () => Effect.die(new Error("Model must not run while appending context")),
};

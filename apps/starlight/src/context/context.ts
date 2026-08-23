import type {
  ConversationCheckpointReason,
  ConversationContextRole,
  ConversationTranscriptKind,
  Prisma,
} from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Schema } from "effect";
import { z } from "zod";
import * as ChatReply from "@/ai/chat-reply";
import { selected } from "@/ai/model-profile";
import * as Model from "@/ai/model";
import * as CacheDiagnostics from "@/context/cache-diagnostics";
import * as Prompt from "@/context/prompt";
import type * as ConversationKey from "@/conversation/key";
import * as Lane from "@/conversation/lane";
import * as Database from "@/services/database";
import * as Exa from "@/services/exa";

export interface PreparedContextRequest {
  readonly cacheBase: string;
  readonly contextId: string;
  readonly estimatedTokens: {
    readonly base: number;
    readonly current: number;
    readonly finalized: number;
    readonly total: number;
  };
  readonly instructions: string;
  readonly messages: readonly Model.Message[];
  readonly profileFingerprint: string;
  readonly requestHash: string;
  readonly terminalPrefixHash: string;
  readonly webLookupEnabled: boolean;
}

export interface RunReference {
  readonly fencingToken: bigint;
  readonly runId: string;
}

export interface CheckpointInput extends RunReference {
  readonly reason: ConversationCheckpointReason;
  readonly retainedTokenTarget: number;
}

export interface CheckpointResult {
  readonly childContextId: string;
  readonly generation: number;
  readonly retainedTurns: number;
}

export interface AppendResult {
  readonly appendedTurns: number;
  readonly contextId: string;
  readonly estimatedStableTokens: number;
  readonly terminalPrefixHash: string;
}

export interface ProfileTransitionInput {
  readonly key: ConversationKey.Value;
  readonly reason: string;
  readonly run?: RunReference;
  readonly webLookupEnabled: boolean;
}

export interface ContextGeneration {
  readonly generation: number;
  readonly id: string;
  readonly profileFingerprint: string;
}

export class ContextError extends Schema.TaggedError<ContextError>()("ContextError", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export interface Interface {
  readonly appendFinalized: (input: RunReference) => Effect.Effect<AppendResult, ContextError>;
  readonly checkpoint: (input: CheckpointInput) => Effect.Effect<CheckpointResult, ContextError>;
  readonly prepare: (input: RunReference) => Effect.Effect<PreparedContextRequest, ContextError>;
  readonly resumeCheckpoint: (
    input: Omit<CheckpointInput, "reason">,
  ) => Effect.Effect<CheckpointResult | null, ContextError>;
  readonly transitionProfile: (input: ProfileTransitionInput) => Effect.Effect<ContextGeneration, ContextError>;
}

export class Service extends Context.Service<Service, Interface>()("starlight/ConversationContext") {}

export const layer: Layer.Layer<Service, never, Database.Service | Exa.Service | Model.Service> = Layer.effect(
  Service,
  Effect.gen(function* layer() {
    const database = yield* Database.Service;
    const exa = yield* Exa.Service;
    const model = yield* Model.Service;
    const prefixSnapshots = new Map<string, CacheDiagnostics.PrefixSnapshot>();

    const appendFinalized = Effect.fn("ConversationContext.appendFinalized")(function* appendFinalized(
      input: RunReference,
    ) {
      return yield* database
        .transaction(async (transaction) => {
          const run = await transaction.conversationRun.findUniqueOrThrow({
            where: { id: input.runId },
            include: {
              actions: { orderBy: { ordinal: "asc" } },
              inputs: { include: { input: true }, orderBy: { ordinal: "asc" } },
              toolCalls: { orderBy: { createdAt: "asc" } },
            },
          });
          const key = {
            assistantId: run.assistantId,
            chatId: run.chatId,
            threadKey: run.threadKey,
          };
          await Lane.assertFence(transaction, key, input);
          if (run.actions.some((action) => !["delivered", "failed"].includes(action.deliveryStatus))) {
            throw new Error("Run delivery is not terminal");
          }
          const existingRunTurns = await transaction.conversationTranscriptTurn.count({
            where: { runId: input.runId },
          });
          // One Prisma transaction connection must execute its queries serially.
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await
          const context = run.contextId
            ? await transaction.conversationContext.findUniqueOrThrow({ where: { id: run.contextId } })
            : await ensureActiveContext(transaction, key, exa.isEnabled());
          if (run.contextId === null) {
            await transaction.conversationRun.update({
              where: { id: run.id },
              data: { contextId: context.id },
            });
          }
          if (existingRunTurns > 0) {
            const terminal = await transaction.conversationContextTurn.findFirst({
              where: { contextId: context.id },
              orderBy: { ordinal: "desc" },
            });
            return {
              appendedTurns: 0,
              contextId: context.id,
              estimatedStableTokens: context.estimatedStableTokens,
              terminalPrefixHash: terminal?.rollingPrefixHash ?? context.basePrefixHash,
            };
          }

          const existingTurns = await transaction.conversationTranscriptTurn.findMany({
            where: key,
            orderBy: { ordinal: "asc" },
          });
          const knownMessageIds = collectMessageIds(existingTurns.map((turn) => turn.content));
          const projections = createProjections(run, knownMessageIds);
          const firstOrdinal = (existingTurns.at(-1)?.ordinal ?? 0) + 1;
          const contextTurns = await transaction.conversationContextTurn.findMany({
            where: { contextId: context.id },
            orderBy: { ordinal: "asc" },
          });
          let rollingHash = contextTurns.at(-1)?.rollingPrefixHash ?? context.basePrefixHash;
          let estimatedTokens = context.estimatedStableTokens;

          for (const [index, projection] of projections.entries()) {
            const ordinal = firstOrdinal + index;
            const transcript = await transaction.conversationTranscriptTurn.create({
              data: {
                ...key,
                content: projection.content,
                idempotencyKey: `${input.runId}:${projection.key}`,
                kind: projection.kind,
                ordinal,
                runId: input.runId,
                sourceReferences: projection.sourceReferences,
                visibility: projection.visibility,
              },
            });
            const rendered = Prompt.renderTurn({
              content: Prompt.canonicalEncode(projection.content),
              role: projection.role,
            });
            const segment = Prompt.extendPrefix(rollingHash, rendered);
            rollingHash = segment.rollingPrefixHash;
            estimatedTokens += segment.estimatedTokens;
            await transaction.conversationContextTurn.create({
              data: {
                contextId: context.id,
                estimatedTokens: segment.estimatedTokens,
                ordinal: contextTurns.length + index + 1,
                renderedContent: rendered,
                renderVersion: Prompt.renderVersion,
                role: projection.role,
                rollingPrefixHash: segment.rollingPrefixHash,
                segmentHash: segment.segmentHash,
                transcriptTurnId: transcript.id,
              },
            });
          }
          await transaction.conversationContext.update({
            where: { id: context.id },
            data: { estimatedStableTokens: estimatedTokens },
          });

          return {
            appendedTurns: projections.length,
            contextId: context.id,
            estimatedStableTokens: estimatedTokens,
            terminalPrefixHash: rollingHash,
          };
        })
        .pipe(Effect.mapError(failed("Failed to append finalized context")));
    });

    const prepare = Effect.fn("ConversationContext.prepare")(function* prepare(input: RunReference) {
      const outcome = yield* database
        .transaction(async (transaction) => {
          const run = await transaction.conversationRun.findUniqueOrThrow({
            where: { id: input.runId },
            include: {
              inputs: { include: { input: true }, orderBy: { ordinal: "asc" } },
            },
          });

          const key = {
            assistantId: run.assistantId,
            chatId: run.chatId,
            threadKey: run.threadKey,
          };
          await Lane.assertFence(transaction, key, input);
          const context = run.contextId
            ? await transaction.conversationContext.findUniqueOrThrow({ where: { id: run.contextId } })
            : await ensureActiveContext(transaction, key, exa.isEnabled());
          if (context.status !== "active") throw new Error("Pinned context is not active");
          if (context.modelProfileFingerprint !== run.modelProfileFingerprint) {
            throw new Error("Active context profile does not match the prepared run");
          }
          if (context.modelProfileFingerprint !== Prompt.profileFingerprint(exa.isEnabled())) {
            throw new ContextError({
              message: "Prepared run profile is no longer available",
              retryable: false,
            });
          }
          const turns = await transaction.conversationContextTurn.findMany({
            where: { contextId: context.id },
            orderBy: { ordinal: "asc" },
            include: { transcriptTurn: true },
          });
          const knownMessageIds = collectMessageIds(turns.map((turn) => turn.transcriptTurn.content));
          // Dot notation is the project convention; destructuring is intentionally disabled.
          // oxlint-disable-next-line prefer-destructuring
          const currentDate = Schema.decodeUnknownSync(PreparedRequestMetadata)(run.preparedRequest).currentDate;
          const current = [
            {
              role: "user" as const,
              text: `TRUSTED REQUEST METADATA\nCurrent date: ${currentDate}`,
            },
            ...run.inputs.map((runInput) => {
              const payload = Schema.decodeUnknownSync(StoredPayload)(runInput.input.payload);
              return {
                role: "user" as const,
                text: Prompt.renderLiveMessage(payload, Prompt.describeReplyTarget(payload, knownMessageIds)),
              };
            }),
          ];
          const finalized = turns.map((turn) => ({
            role: turn.role === "assistant" ? ("assistant" as const) : ("user" as const),
            text: turn.renderedContent,
          }));
          const messages = [...finalized, ...current];
          const cacheBase = context.frozenMemory;
          const envelope = Schema.decodeUnknownSync(Prompt.FrozenEnvelope)(context.stableEnvelope);
          const finalizedTokens = turns.reduce((total, turn) => total + turn.estimatedTokens, 0);
          const currentTokens = current.reduce((total, message) => total + Math.ceil(message.text.length / 4), 0);
          const baseTokens = Math.ceil(context.stableEnvelope.length / 4) + Math.ceil(cacheBase.length / 4);
          const terminalPrefixHash = verifyPrefix(context.basePrefixHash, turns);
          const prepared = {
            cacheBase,
            contextId: context.id,
            estimatedTokens: {
              base: baseTokens,
              current: currentTokens,
              finalized: finalizedTokens,
              total: baseTokens + finalizedTokens + currentTokens,
            },
            instructions: envelope.instructions,
            messages,
            profileFingerprint: context.modelProfileFingerprint,
            requestHash: new Bun.CryptoHasher("sha256")
              .update(
                Prompt.canonicalEncode({
                  cacheBase,
                  instructions: envelope.instructions,
                  messages,
                  profileFingerprint: context.modelProfileFingerprint,
                  terminalPrefixHash,
                  webLookupEnabled: envelope.tools.length > 0,
                }),
              )
              .digest("hex"),
            terminalPrefixHash,
            webLookupEnabled: envelope.tools.length > 0,
          };
          const snapshot: CacheDiagnostics.PrefixSnapshot = {
            messages: messages.map((message) => new Bun.CryptoHasher("sha256").update(message.text).digest("hex")),
            settings: `${selected.model}:${selected.reasoning}:${envelope.tools.length > 0}`,
            system: [
              new Bun.CryptoHasher("sha256").update(context.stableEnvelope).digest("hex"),
              new Bun.CryptoHasher("sha256").update(cacheBase).digest("hex"),
            ],
          };
          if (run.requestHash !== null && run.requestHash !== prepared.requestHash) {
            // Rendering changed between freeze and replay (typically a deploy). Retrying cannot
            // succeed because attemptCount only advances during model invocation, so surface a
            // permanent error for the caller to block the run instead of redriving forever.
            throw new ContextError({
              message: "Prepared context request changed after it was frozen",
              retryable: false,
            });
          }
          await transaction.conversationRun.update({
            where: { id: run.id },
            data: { contextId: context.id, requestHash: prepared.requestHash },
          });
          return { prepared, snapshot };
        })
        .pipe(Effect.mapError(failed("Failed to prepare context request")));
      const previous = prefixSnapshots.get(outcome.prepared.contextId);
      prefixSnapshots.set(outcome.prepared.contextId, outcome.snapshot);
      const verdict = CacheDiagnostics.comparePrefix(previous, outcome.snapshot);
      const annotations: Record<string, string | number> = {
        contextId: outcome.prepared.contextId,
        messageCount: outcome.snapshot.messages.length,
        status: verdict.status,
      };
      if (verdict.status === "append-only") annotations.appendedMessages = verdict.appendedMessages;
      if (verdict.status === "changed") annotations.component = verdict.changed;
      if (previous !== undefined) annotations.previousMessageCount = previous.messages.length;
      yield* (
        verdict.status === "changed"
          ? Effect.logWarning("Prepared context prefix changed")
          : Effect.logDebug("Prepared context prefix compared")
      ).pipe(Effect.annotateLogs(annotations));
      return outcome.prepared;
    });

    const checkpoint = Effect.fn("ConversationContext.checkpoint")(function* checkpoint(
      checkpointInput: CheckpointInput,
    ) {
      const prepared = yield* database
        .transaction((client) => prepareCheckpoint(client, checkpointInput, Prompt.profileFingerprint(exa.isEnabled())))
        .pipe(Effect.mapError(failed("Failed to prepare context checkpoint")));
      if (prepared.kind === "notPossible") {
        return yield* new ContextError({ message: prepared.message, retryable: false });
      }
      if (prepared.kind === "committed") return prepared.result;

      const summarized = prepared.summary ?? (yield* summarizeCheckpoint(database, model, prepared, checkpointInput));

      const result = yield* database
        .transaction((client) => commitCheckpoint(client, checkpointInput, prepared, summarized))
        .pipe(Effect.mapError(failed("Failed to commit context checkpoint")));
      yield* Effect.logInfo("Context checkpoint committed").pipe(
        Effect.annotateLogs({
          childContextId: result.childContextId,
          generation: result.generation,
          parentContextId: prepared.parentContextId,
          reason: checkpointInput.reason,
          retainedTurns: result.retainedTurns,
        }),
      );
      return result;
    });

    const resumeCheckpoint = Effect.fn("ConversationContext.resumeCheckpoint")(function* resumeCheckpoint(
      checkpointInput: Omit<CheckpointInput, "reason">,
    ) {
      const attempt = yield* database
        .query((client) =>
          client.conversationCheckpointAttempt.findFirst({
            where: {
              OR: [
                { status: { in: ["prepared", "summarizing", "summarized"] } },
                { reason: "hardSafety", status: "failed" },
              ],
              runId: checkpointInput.runId,
            },
            include: { parentContext: true },
            orderBy: { createdAt: "desc" },
          }),
        )
        .pipe(Effect.mapError(failed("Failed to find resumable context checkpoint")));
      if (!attempt) return null;
      if (attempt.parentContext.modelProfileFingerprint !== Prompt.profileFingerprint(exa.isEnabled())) {
        yield* database
          .transaction(async (transaction) => {
            const key = {
              assistantId: attempt.parentContext.assistantId,
              chatId: attempt.parentContext.chatId,
              threadKey: attempt.parentContext.threadKey,
            };
            await Lane.assertFence(transaction, key, checkpointInput);
            await transaction.conversationCheckpointAttempt.update({
              where: { id: attempt.id },
              data: {
                completedAt: new Date(),
                lastError: "Checkpoint profile is no longer available",
                status: "aborted",
              },
            });
            await transaction.conversationContext.updateMany({
              where: { id: attempt.parentContextId, status: { in: ["checkpointing", "retryNeeded"] } },
              data: { status: "active" },
            });
          })
          .pipe(Effect.mapError(failed("Failed to abort stale context checkpoint")));
        return null;
      }
      return yield* checkpoint({ ...checkpointInput, reason: attempt.reason });
    });

    const transitionProfile = Effect.fn("ConversationContext.transitionProfile")(function* transitionProfile(
      input: ProfileTransitionInput,
    ) {
      return yield* database
        .transaction(async (transaction) => {
          const key = {
            assistantId: BigInt(input.key.assistantId),
            chatId: BigInt(input.key.chatId),
            threadKey: input.key.threadKey,
          };
          await Lane.lockLane(transaction, key);
          if (input.run) await Lane.assertFence(transaction, key, input.run);
          const profileFingerprint = Prompt.profileFingerprint(input.webLookupEnabled);
          const run = input.run
            ? await transaction.conversationRun.findUniqueOrThrow({ where: { id: input.run.runId } })
            : null;
          if (run?.contextId) {
            const pinned = await transaction.conversationContext.findUniqueOrThrow({
              where: { id: run.contextId },
            });
            if (
              pinned.modelProfileFingerprint !== profileFingerprint ||
              run.modelProfileFingerprint !== profileFingerprint
            ) {
              throw new ContextError({
                message: "Prepared run profile is no longer available",
                retryable: false,
              });
            }
            return {
              generation: pinned.generation,
              id: pinned.id,
              profileFingerprint: pinned.modelProfileFingerprint,
            };
          }
          const existing = await transaction.conversationContext.findFirst({
            where: { ...key, status: "active" },
          });
          const parent = existing ?? (await ensureActiveContext(transaction, key, input.webLookupEnabled));
          const envelope = Prompt.renderEnvelope({
            webLookupEnabled: input.webLookupEnabled,
          });
          if (parent.modelProfileFingerprint === profileFingerprint) {
            if (input.run) {
              await transaction.conversationRun.update({
                where: { id: input.run.runId },
                data: { contextId: parent.id },
              });
            }
            return {
              generation: parent.generation,
              id: parent.id,
              profileFingerprint: parent.modelProfileFingerprint,
            };
          }
          const memory = parent.frozenMemory;
          await transaction.conversationContext.update({
            where: { id: parent.id },
            data: {
              activeKey: null,
              sealedAt: new Date(),
              status: "checkpointing",
            },
          });
          const child = await transaction.conversationContext.create({
            data: {
              ...key,
              activeKey: `v1/${input.key.assistantId}/${input.key.chatId}/${input.key.threadKey}`,
              generation: parent.generation + 1,
              modelProfileFingerprint: profileFingerprint,
              parentContextId: parent.id,
              resetReason: input.reason,
              ...stableSeed(envelope, memory),
            },
          });
          // One Prisma transaction connection must execute its queries serially.
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await
          const retained = await transaction.conversationContextTurn.findMany({
            where: { contextId: parent.id },
            orderBy: { ordinal: "asc" },
            include: { transcriptTurn: true },
          });
          let rollingHash = child.basePrefixHash;
          let estimatedTokens = child.estimatedStableTokens;
          for (const [index, turn] of retained.entries()) {
            const role = ROLE_BY_KIND[turn.transcriptTurn.kind];
            const rendered = Prompt.renderTurn({
              content: Prompt.canonicalEncode(turn.transcriptTurn.content),
              role,
            });
            const segment = Prompt.extendPrefix(rollingHash, rendered);
            rollingHash = segment.rollingPrefixHash;
            estimatedTokens += segment.estimatedTokens;
            await transaction.conversationContextTurn.create({
              data: {
                contextId: child.id,
                estimatedTokens: segment.estimatedTokens,
                ordinal: index + 1,
                renderedContent: rendered,
                renderVersion: Prompt.renderVersion,
                role,
                rollingPrefixHash: segment.rollingPrefixHash,
                segmentHash: segment.segmentHash,
                transcriptTurnId: turn.transcriptTurnId,
              },
            });
          }
          await transaction.conversationContext.update({
            where: { id: parent.id },
            data: { status: "superseded" },
          });
          await transaction.conversationContext.update({
            where: { id: child.id },
            data: { estimatedStableTokens: estimatedTokens },
          });
          await transaction.conversationLane.update({
            where: { assistantId_chatId_threadKey: key },
            data: { activeContextId: child.id },
          });
          if (input.run) {
            await transaction.conversationRun.update({
              where: { id: input.run.runId },
              data: { contextId: child.id, requestHash: null },
            });
          }

          return {
            generation: child.generation,
            id: child.id,
            profileFingerprint: child.modelProfileFingerprint,
          };
        })
        .pipe(Effect.mapError(failed("Failed to transition context profile")));
    });

    return Service.of({ appendFinalized, checkpoint, prepare, resumeCheckpoint, transitionProfile });
  }),
);

type PreparedCheckpoint =
  | { readonly kind: "committed"; readonly result: CheckpointResult }
  | { readonly kind: "notPossible"; readonly message: string }
  | ({ readonly kind: "ready" } & ReadyCheckpoint);

interface CheckpointTailTurn {
  readonly renderedContent: string;
  readonly role: ConversationContextRole;
  readonly transcriptTurnId: bigint;
}

interface ReadyCheckpoint {
  readonly attemptId: string;
  readonly key: Lane.LaneKey;
  readonly parentContextId: string;
  readonly summary: string | null;
  readonly summaryInput: string;
  readonly tail: readonly CheckpointTailTurn[];
}

const CHECKPOINT_INSTRUCTIONS = `Summarize the conversation history for future continuity.
Preserve speaker attribution, current decisions, corrections, open questions, tool-derived facts, media facts, and unfinished work.
Remove obsolete intermediate wording and repeated greetings. Do not invent facts.`;
const CheckpointSummary = z.object({ summary: z.string().min(1) });

const failed =
  (message: string) =>
  (cause: unknown): ContextError => {
    // ContextErrors thrown inside a Prisma callback arrive wrapped in TransactionError;
    // unwrap them so their retryability classification survives this mapping.
    const direct = cause instanceof Database.TransactionError ? cause.cause : cause;
    if (direct instanceof ContextError) return direct;
    return new ContextError({ cause, message, retryable: true });
  };

function summarizeCheckpoint(
  database: Database.Interface,
  model: Model.Interface,
  prepared: ReadyCheckpoint,
  checkpointInput: CheckpointInput,
) {
  return Effect.gen(function* generateCheckpointSummary() {
    yield* database
      .transaction(async (transaction) => {
        await Lane.assertFence(transaction, prepared.key, checkpointInput);
        await transaction.conversationCheckpointAttempt.update({
          where: { id: prepared.attemptId },
          data: { attemptCount: { increment: 1 }, lastError: null, status: "summarizing" },
        });
      })
      .pipe(Effect.mapError(failed("Failed to start context summary")));
    const generated = yield* model
      .generate({
        instructions: CHECKPOINT_INSTRUCTIONS,
        maxOutputTokens: 2048,
        maxToolCalls: 0,
        messages: [{ role: "user", text: prepared.summaryInput }],
        outputSchema: CheckpointSummary,
        sessionId: prepared.parentContextId,
        tools: [],
      })
      .pipe(
        // Preserve the model's classification: resumeCheckpoint re-picks failed hardSafety
        // attempts without an attempt bound, so a permanent failure marked retryable here
        // would be retried forever.
        Effect.mapError(
          (error) =>
            new ContextError({ cause: error, message: "Failed to summarize context", retryable: error.retryable }),
        ),
      );
    const summary = generated.output.summary.trim();
    if (summary.length === 0) {
      return yield* new ContextError({ message: "Context summary was empty", retryable: true });
    }
    yield* database
      .transaction(async (transaction) => {
        await Lane.assertFence(transaction, prepared.key, checkpointInput);
        await transaction.conversationCheckpointAttempt.update({
          where: { id: prepared.attemptId },
          data: {
            status: "summarized",
            summaryOutput: { summary },
            summaryUsage: {
              generation: structuredClone(generated.usage) as Prisma.InputJsonObject,
              steps: structuredClone(generated.steps) as Prisma.InputJsonArray,
            },
          },
        });
      })
      .pipe(Effect.mapError(failed("Failed to persist context summary")));
    return summary;
  }).pipe(
    Effect.tapError((error) =>
      database
        .transaction(async (transaction) => {
          await Lane.assertFence(transaction, prepared.key, checkpointInput);
          await transaction.conversationCheckpointAttempt.updateMany({
            where: { id: prepared.attemptId, status: { not: "committed" } },
            data: { lastError: error.message, status: "failed" },
          });
          await transaction.conversationContext.updateMany({
            where: { id: prepared.parentContextId, status: "checkpointing" },
            data: { status: checkpointInput.reason === "hardSafety" ? "retryNeeded" : "active" },
          });
        })
        .pipe(Effect.ignore),
    ),
  );
}

async function prepareCheckpoint(
  transaction: Prisma.TransactionClient,
  input: CheckpointInput,
  currentProfileFingerprint: string,
): Promise<PreparedCheckpoint> {
  const run = await transaction.conversationRun.findUniqueOrThrow({ where: { id: input.runId } });
  const key = { assistantId: run.assistantId, chatId: run.chatId, threadKey: run.threadKey };
  await Lane.assertFence(transaction, key, input);
  if (run.contextId === null) throw new Error("Run has no pinned context");
  const parent = await transaction.conversationContext.findUniqueOrThrow({
    where: { id: run.contextId },
  });
  if (parent.modelProfileFingerprint !== currentProfileFingerprint) {
    throw new ContextError({
      message: "Context profile changed before checkpoint completion",
      retryable: false,
    });
  }
  const existing = await transaction.conversationCheckpointAttempt.findUnique({
    where: {
      parentContextId_runId_reason: {
        parentContextId: parent.id,
        reason: input.reason,
        runId: input.runId,
      },
    },
  });
  if (existing?.status === "committed" && existing.childContextId) {
    const child = await transaction.conversationContext.findUniqueOrThrow({
      where: { id: existing.childContextId },
    });
    return {
      kind: "committed",
      result: {
        childContextId: child.id,
        generation: child.generation,
        // Count the published child turns so replays report the same retained size as
        // the original commit instead of a placeholder zero.
        retainedTurns: await transaction.conversationContextTurn.count({ where: { contextId: child.id } }),
      },
    };
  }
  if (!["active", "checkpointing", "retryNeeded"].includes(parent.status)) {
    throw new Error("Context cannot be checkpointed from its current state");
  }

  const turns = await transaction.conversationContextTurn.findMany({
    where: { contextId: parent.id },
    orderBy: { ordinal: "asc" },
    include: { transcriptTurn: true },
  });
  if (existing && turns.at(-1)?.transcriptTurn.ordinal !== existing.sealedThroughTurnOrdinal) {
    throw new Error("Checkpoint parent changed after its boundary was sealed");
  }
  const boundaries = resolveCheckpointBoundary(turns, existing, input.retainedTokenTarget);
  if (boundaries === null) {
    return { kind: "notPossible", message: "Context has no complete head unit to summarize" };
  }
  const summaryInput = existing
    ? existing.summaryInput
    : Prompt.canonicalEncode({
        head: boundaries.head.map((turn) => turn.renderedContent),
        previousMemory: parent.frozenMemory,
        version: "context-checkpoint-v1",
      });
  if (existing && new Bun.CryptoHasher("sha256").update(summaryInput).digest("hex") !== existing.summaryInputHash) {
    throw new Error("Stored checkpoint input hash is invalid");
  }
  const summaryProfileFingerprint = new Bun.CryptoHasher("sha256")
    .update(`${parent.modelProfileFingerprint}:context-checkpoint-v1`)
    .digest("hex");
  const attempt = existing
    ? await transaction.conversationCheckpointAttempt.update({
        where: { id: existing.id },
        data: {
          lastError: null,
          parentFencingToken: input.fencingToken,
          status: existing.status === "summarized" ? "summarized" : "prepared",
        },
      })
    : await transaction.conversationCheckpointAttempt.create({
        data: {
          headEndTurnOrdinal: boundaries.head.at(-1)!.transcriptTurn.ordinal,
          parentContextId: parent.id,
          parentFencingToken: input.fencingToken,
          reason: input.reason,
          retainedEndTurnOrdinal: boundaries.tail.at(-1)?.transcriptTurn.ordinal,
          retainedStartTurnOrdinal: boundaries.tail[0]?.transcriptTurn.ordinal,
          runId: input.runId,
          sealedThroughTurnOrdinal: turns.at(-1)!.transcriptTurn.ordinal,
          summaryInput,
          summaryInputHash: new Bun.CryptoHasher("sha256").update(summaryInput).digest("hex"),
          summaryProfileFingerprint,
        },
      });
  await transaction.conversationContext.update({
    where: { id: parent.id },
    data: { status: "checkpointing" },
  });
  const storedSummary = attempt.summaryOutput ? CheckpointSummary.parse(attempt.summaryOutput).summary.trim() : null;

  return {
    kind: "ready",
    attemptId: attempt.id,
    key,
    parentContextId: parent.id,
    summary: storedSummary,
    summaryInput: attempt.summaryInput,
    tail: boundaries.tail.map((turn) => ({
      renderedContent: turn.renderedContent,
      role: turn.role,
      transcriptTurnId: turn.transcriptTurnId,
    })),
  };
}

async function commitCheckpoint(
  transaction: Prisma.TransactionClient,
  input: CheckpointInput,
  prepared: ReadyCheckpoint,
  summary: string,
): Promise<CheckpointResult> {
  await Lane.assertFence(transaction, prepared.key, input);
  const attempt = await transaction.conversationCheckpointAttempt.findUniqueOrThrow({
    where: { id: prepared.attemptId },
  });
  if (attempt.status === "committed" && attempt.childContextId) {
    const child = await transaction.conversationContext.findUniqueOrThrow({
      where: { id: attempt.childContextId },
    });
    return {
      childContextId: child.id,
      generation: child.generation,
      retainedTurns: prepared.tail.length,
    };
  }
  if (attempt.status !== "summarized") throw new Error("Checkpoint summary is not ready");
  const parent = await transaction.conversationContext.findUniqueOrThrow({
    where: { id: prepared.parentContextId },
  });
  if (!["checkpointing", "retryNeeded"].includes(parent.status)) {
    throw new Error("Checkpoint parent changed before publication");
  }
  const memory = Prompt.renderMemory(summary);
  await transaction.conversationContext.update({
    where: { id: parent.id },
    data: { activeKey: null },
  });
  const child = await transaction.conversationContext.create({
    data: {
      assistantId: parent.assistantId,
      chatId: parent.chatId,
      threadKey: parent.threadKey,
      activeKey: `v1/${Number(parent.assistantId)}/${Number(parent.chatId)}/${parent.threadKey}`,
      generation: parent.generation + 1,
      modelProfileFingerprint: parent.modelProfileFingerprint,
      parentContextId: parent.id,
      resetReason: input.reason,
      retainedFromTurnOrdinal: attempt.retainedStartTurnOrdinal,
      summaryThroughInputSequence: BigInt(attempt.headEndTurnOrdinal),
      ...stableSeed(parent.stableEnvelope, memory),
    },
  });
  let rollingHash = child.basePrefixHash;
  let estimatedTokens = child.estimatedStableTokens;
  for (const [index, turn] of prepared.tail.entries()) {
    const segment = Prompt.extendPrefix(rollingHash, turn.renderedContent);
    rollingHash = segment.rollingPrefixHash;
    estimatedTokens += segment.estimatedTokens;
    await transaction.conversationContextTurn.create({
      data: {
        contextId: child.id,
        estimatedTokens: segment.estimatedTokens,
        ordinal: index + 1,
        renderedContent: turn.renderedContent,
        renderVersion: Prompt.renderVersion,
        role: turn.role,
        rollingPrefixHash: segment.rollingPrefixHash,
        segmentHash: segment.segmentHash,
        transcriptTurnId: turn.transcriptTurnId,
      },
    });
  }
  await transaction.conversationContext.update({
    where: { id: child.id },
    data: { estimatedStableTokens: estimatedTokens },
  });
  await transaction.conversationContext.update({
    where: { id: parent.id },
    data: { sealedAt: new Date(), status: "superseded" },
  });
  await transaction.conversationCheckpointAttempt.update({
    where: { id: attempt.id },
    data: { childContextId: child.id, completedAt: new Date(), status: "committed" },
  });
  await transaction.conversationLane.update({
    where: { assistantId_chatId_threadKey: prepared.key },
    data: { activeContextId: child.id },
  });
  if (input.reason === "hardSafety") {
    await transaction.conversationRun.update({
      where: { id: input.runId },
      data: { contextId: child.id, requestHash: null },
    });
  }
  return { childContextId: child.id, generation: child.generation, retainedTurns: prepared.tail.length };
}

function selectCheckpointBoundary<
  Turn extends {
    readonly estimatedTokens: number;
    readonly transcriptTurn: { readonly ordinal: number; readonly runId: string };
  },
>(turns: readonly Turn[], retainedTokenTarget: number): { readonly head: Turn[]; readonly tail: Turn[] } | null {
  const units: { runId: string; start: number; tokens: number }[] = [];
  for (const [index, turn] of turns.entries()) {
    const current = units.at(-1);
    if (current?.runId === turn.transcriptTurn.runId) {
      current.tokens += turn.estimatedTokens;
      continue;
    }
    units.push({ runId: turn.transcriptTurn.runId, start: index, tokens: turn.estimatedTokens });
  }
  if (units.length < 2) return null;

  let retainedTokens = 0;
  let tailStart = turns.length;
  for (const unit of units.slice(1).toReversed()) {
    if (retainedTokens >= retainedTokenTarget) break;
    tailStart = unit.start;
    retainedTokens += unit.tokens;
  }
  return { head: turns.slice(0, tailStart), tail: turns.slice(tailStart) };
}

function resolveCheckpointBoundary<
  Turn extends {
    readonly estimatedTokens: number;
    readonly transcriptTurn: { readonly ordinal: number; readonly runId: string };
  },
>(
  turns: readonly Turn[],
  existing: {
    readonly headEndTurnOrdinal: number;
    readonly retainedStartTurnOrdinal: number | null;
  } | null,
  retainedTokenTarget: number,
): { readonly head: Turn[]; readonly tail: Turn[] } | null {
  if (!existing) return selectCheckpointBoundary(turns, retainedTokenTarget);
  const retainedStart = existing.retainedStartTurnOrdinal;
  return {
    head: turns.filter((turn) => turn.transcriptTurn.ordinal <= existing.headEndTurnOrdinal),
    tail: retainedStart === null ? [] : turns.filter((turn) => turn.transcriptTurn.ordinal >= retainedStart),
  };
}

function verifyPrefix(
  basePrefixHash: string,
  turns: readonly {
    readonly renderedContent: string;
    readonly rollingPrefixHash: string;
    readonly segmentHash: string;
  }[],
): string {
  let rollingHash = basePrefixHash;
  for (const turn of turns) {
    const segment = Prompt.extendPrefix(rollingHash, turn.renderedContent);
    if (segment.segmentHash !== turn.segmentHash || segment.rollingPrefixHash !== turn.rollingPrefixHash) {
      throw new Error("Context prefix chain is invalid");
    }
    rollingHash = segment.rollingPrefixHash;
  }
  return rollingHash;
}

const ROLE_BY_KIND: Record<ConversationTranscriptKind, ConversationContextRole> = {
  assistantIgnore: "assistant",
  assistantMessage: "assistant",
  editCorrection: "user",
  linkedReplyContext: "user",
  mediaProjection: "user",
  systemEvent: "system",
  toolCall: "assistant",
  toolError: "tool",
  toolResult: "tool",
  userMessage: "user",
};

function collectMessageIds(contents: readonly Prisma.JsonValue[]): Set<number> {
  return new Set(
    contents.flatMap((content) => {
      if (!content || typeof content !== "object" || Array.isArray(content)) return [];
      return [
        ...(typeof content.messageId === "number" ? [content.messageId] : []),
        ...(typeof content.telegramMessageId === "number" ? [content.telegramMessageId] : []),
      ];
    }),
  );
}

// The seed fields derive the context base from the frozen envelope and memory;
// both creation paths must produce byte-identical values or the two chains diverge.
function stableSeed(envelope: string, memory: string) {
  return {
    basePrefixHash: new Bun.CryptoHasher("sha256")
      .update(`${envelope.length}:${envelope}${memory.length}:${memory}`)
      .digest("hex"),
    estimatedStableTokens: Math.ceil(envelope.length / 4) + Math.ceil(memory.length / 4),
    frozenMemory: memory,
    frozenMemoryHash: new Bun.CryptoHasher("sha256").update(memory).digest("hex"),
    stableEnvelope: envelope,
    stableEnvelopeHash: new Bun.CryptoHasher("sha256").update(envelope).digest("hex"),
  };
}

interface Projection {
  readonly content: Prisma.InputJsonObject;
  readonly key: string;
  readonly kind: ConversationTranscriptKind;
  readonly role: ConversationContextRole;
  readonly sourceReferences: Prisma.InputJsonObject;
  readonly visibility: string;
}

interface ProjectionRun {
  readonly errorTag: string | null;
  readonly id: string;
  readonly status: string;
  readonly actions: readonly {
    readonly deliveryStatus: string;
    readonly ordinal: number;
    readonly payload: Prisma.JsonValue;
    readonly telegramMessageId: number | null;
    readonly type: string;
  }[];
  readonly inputs: readonly {
    readonly input: {
      readonly id: bigint;
      readonly mediaReferences: Prisma.JsonValue | null;
      readonly payload: Prisma.JsonValue;
    };
  }[];
  readonly toolCalls: readonly {
    readonly errorMessage: string | null;
    readonly input: Prisma.JsonValue;
    readonly providerCallId: string;
    readonly result: Prisma.JsonValue | null;
    readonly status: string;
    readonly toolName: string;
  }[];
}

async function ensureActiveContext(
  transaction: Prisma.TransactionClient,
  key: Lane.LaneKey,
  webLookupEnabled: boolean,
) {
  const existing = await transaction.conversationContext.findFirst({
    where: { ...key, status: "active" },
  });
  if (existing) return existing;

  const envelope = Prompt.renderEnvelope({ webLookupEnabled });
  const memory = Prompt.renderMemory("");
  const created = await transaction.conversationContext.create({
    data: {
      ...key,
      activeKey: `v1/${Number(key.assistantId)}/${Number(key.chatId)}/${key.threadKey}`,
      generation: 1,
      modelProfileFingerprint: Prompt.profileFingerprint(webLookupEnabled),
      ...stableSeed(envelope, memory),
    },
  });
  await transaction.conversationLane.update({
    where: { assistantId_chatId_threadKey: key },
    data: { activeContextId: created.id },
  });
  return created;
}

function createProjections(run: ProjectionRun, knownMessageIds: ReadonlySet<number>): Projection[] {
  const seenMessageIds = new Set(knownMessageIds);
  const userTurns = run.inputs.flatMap((runInput, index) => {
    const payload = Schema.decodeUnknownSync(StoredPayload)(runInput.input.payload);
    // Dot notation is the project convention; destructuring is intentionally disabled.
    // oxlint-disable-next-line prefer-destructuring, sonarjs/destructuring-assignment-syntax
    const messageId = payload.messageId;
    // oxlint-disable-next-line prefer-destructuring
    const replyToMessageId = payload.replyToMessageId;
    const linked =
      replyToMessageId !== null && !seenMessageIds.has(replyToMessageId) && payload.repliedText
        ? [
            {
              content: {
                messageId: replyToMessageId,
                text: payload.repliedText,
              } as Prisma.InputJsonObject,
              key: `input:${runInput.input.id}:linked`,
              kind: "linkedReplyContext" as const,
              role: "user" as const,
              sourceReferences: { inputId: runInput.input.id.toString() },
              visibility: "linked-context",
            },
          ]
        : [];
    if (linked.length > 0 && replyToMessageId !== null) seenMessageIds.add(replyToMessageId);
    seenMessageIds.add(messageId);
    const media = runInput.input.mediaReferences
      ? [
          {
            content: {
              references: runInput.input.mediaReferences as Prisma.InputJsonValue,
            },
            key: `input:${runInput.input.id}:media`,
            kind: "mediaProjection" as const,
            role: "user" as const,
            sourceReferences: { inputId: runInput.input.id.toString() },
            visibility: "conversation",
          },
        ]
      : [];
    return [
      ...linked,
      {
        content: {
          date: payload.date,
          forwardOrigin: payload.forwardOrigin,
          messageId,
          replyToMessageId,
          replyTargetUnavailable: replyToMessageId !== null && payload.repliedText === null,
          senderFirstName: payload.senderFirstName,
          senderId: payload.senderId,
          text: payload.text,
        },
        key: `input:${runInput.input.id}`,
        kind: payload.editDate === null ? ("userMessage" as const) : ("editCorrection" as const),
        role: "user" as const,
        sourceReferences: {
          inputId: runInput.input.id.toString(),
          messageId,
        },
        visibility: "conversation",
      },
      ...media,
    ].map((projection, projectionIndex) => ({
      ...projection,
      key: `${index}:${projectionIndex}:${projection.key}`,
    }));
  });
  const toolTurns = run.toolCalls.flatMap((tool, index) => [
    {
      content: { input: tool.input, name: tool.toolName } as Prisma.InputJsonObject,
      key: `tool:${index}:call:${tool.providerCallId}`,
      kind: "toolCall" as const,
      role: "assistant" as const,
      sourceReferences: { providerCallId: tool.providerCallId },
      visibility: "conversation",
    },
    {
      content: (tool.status === "completed"
        ? { name: tool.toolName, result: tool.result }
        : { error: tool.errorMessage, name: tool.toolName }) as Prisma.InputJsonObject,
      key: `tool:${index}:result:${tool.providerCallId}`,
      kind: tool.status === "completed" ? ("toolResult" as const) : ("toolError" as const),
      role: "tool" as const,
      sourceReferences: { providerCallId: tool.providerCallId },
      visibility: "conversation",
    },
  ]);
  const assistantTurns = run.actions.flatMap((action) => {
    if (action.deliveryStatus !== "delivered") return [];
    const content = ChatReply.actionSchema.parse(action.payload);
    return [
      {
        content: {
          action: content as Prisma.InputJsonObject,
          telegramMessageId: action.telegramMessageId,
        },
        key: `action:${action.ordinal}`,
        kind: action.type === "ignore" ? ("assistantIgnore" as const) : ("assistantMessage" as const),
        role: "assistant" as const,
        sourceReferences: { actionOrdinal: action.ordinal },
        visibility: action.type === "ignore" ? "internal" : "delivered",
      },
    ];
  });
  const failureTurns: Projection[] =
    run.status === "failed"
      ? [
          {
            content: { category: run.errorTag ?? "model-failure" },
            key: "terminal-failure",
            kind: "systemEvent",
            role: "system",
            sourceReferences: { runId: run.id },
            visibility: "internal",
          },
        ]
      : [];

  return [...userTurns, ...toolTurns, ...assistantTurns, ...failureTurns];
}

const StoredPayload = Schema.Struct({
  date: Schema.Int,
  editDate: Schema.NullOr(Schema.Int),
  forwardOrigin: Schema.NullOr(Schema.String),
  messageId: Schema.Int,
  repliedText: Schema.NullOr(Schema.String),
  replyToMessageId: Schema.NullOr(Schema.Int),
  senderFirstName: Schema.String,
  senderId: Schema.NullOr(Schema.Int),
  text: Schema.String,
});

const PreparedRequestMetadata = Schema.Struct({ currentDate: Schema.String });

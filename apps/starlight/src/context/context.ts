import type { ConversationCheckpointReason, Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Number, Predicate, Schema } from "effect";
import { selected } from "@/ai/model-profile";
import { Model } from "@/ai/model";
import { ActiveContext } from "@/context/active-context";
import { CacheDiagnostics } from "@/context/cache-diagnostics";
import { Checkpoint } from "@/context/checkpoint";
import { Prompt } from "@/context/prompt";
import { Transcript } from "@/context/transcript";
import { ChatTools } from "@/ai/chat-tools";
import { ConversationKey } from "@/conversation/key";
import { Lane } from "@/conversation/lane";
import { PreparedRequestSchema, StoredPayloadSchema } from "@/conversation/run-artifacts";
import { Memory } from "@/memory/memory";
import { Media } from "@/media/media";
import { OperationalTelemetry } from "@/operational-telemetry";
import { Database } from "@/services/database";

export namespace ConversationContext {
  const CHECKPOINT_TOOL_OUTPUT_MAX_CHARS = 2000;
  const MAX_REQUEST_MEDIA_BYTES = 20 * 1024 * 1024;
  export interface PreparedContextRequest {
    readonly cacheBase: string;
    readonly contextId: string;
    readonly estimatedTokens: number;
    readonly instructions: string;
    readonly messages: readonly Model.Message[];
    readonly toolProfile: ChatTools.Profile;
  }

  export interface RunReference {
    readonly fencingToken: bigint;
    readonly runId: string;
  }

  export interface CheckpointInput extends RunReference {
    readonly leaseMs: number;
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
    readonly toolProfile: ChatTools.Profile;
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

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const database = yield* Database.Service;
      const chatTools = yield* ChatTools.Service;
      const memoryService = yield* Memory.Service;
      const media = yield* Media.Service;
      const model = yield* Model.Service;
      const prefixSnapshots = new Map<string, CacheDiagnostics.PrefixSnapshot>();

      const appendFinalized = Effect.fn("ConversationContext.appendFinalized")(function* appendFinalized(
        input: RunReference,
      ) {
        const runContext = yield* database
          .query((client) =>
            client.conversationRun.findUniqueOrThrow({
              where: { id: input.runId },
              select: { assistantId: true, chatId: true, contextId: true, threadKey: true },
            }),
          )
          .pipe(Effect.mapError(failed("Failed to find finalized run context")));
        const initialMemory =
          runContext.contextId === null
            ? yield* memoryService
                .freezeContextMemory(runContext, "")
                .pipe(Effect.mapError(failed("Failed to freeze initial context memory")))
            : "";
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
              : await ActiveContext.ensure(transaction, key, chatTools.availableProfile, initialMemory);
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
              select: { ordinal: true, sourceMessageId: true },
            });
            const knownMessageIds = new Set(
              existingTurns.flatMap((turn) => (turn.sourceMessageId === null ? [] : [turn.sourceMessageId])),
            );
            const projections = Transcript.projectRun(run, knownMessageIds);
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
                  sourceMessageId: projection.sourceMessageId,
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
            await Memory.recordFinalized(transaction, run);

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
        const runContext = yield* database
          .query((client) =>
            client.conversationRun.findUniqueOrThrow({
              where: { id: input.runId },
              select: { assistantId: true, chatId: true, contextId: true, threadKey: true },
            }),
          )
          .pipe(Effect.mapError(failed("Failed to find prepared run context")));
        const mediaInputs = yield* database
          .query((client) =>
            client.conversationRunInput.findMany({
              where: { runId: input.runId },
              include: { input: { select: { id: true, payload: true } } },
              orderBy: { ordinal: "asc" },
            }),
          )
          .pipe(Effect.mapError(failed("Failed to find prepared run media")));
        const mediaBytes = Number.sumAll(
          mediaInputs.flatMap((runInput) => {
            const payload = Schema.decodeUnknownSync(StoredPayloadSchema)(runInput.input.payload);
            return [...payload.repliedMedia, ...payload.media].map((reference) =>
              reference.availability === "stored" ? reference.size : 0,
            );
          }),
        );
        if (mediaBytes > MAX_REQUEST_MEDIA_BYTES) {
          return yield* new ContextError({
            message: "Prepared request media exceeds the 20 MiB aggregate boundary",
            retryable: false,
          });
        }
        const loadedMedia = new Map(
          yield* Effect.all(
            mediaInputs.map((runInput) => {
              const payload = Schema.decodeUnknownSync(StoredPayloadSchema)(runInput.input.payload);
              return Effect.all([...payload.repliedMedia, ...payload.media].map(media.load), {
                concurrency: "unbounded",
              }).pipe(
                Effect.map((items) => [runInput.input.id, items.filter(Predicate.isNotNull)] as const),
                Effect.mapError(
                  (error) => new ContextError({ cause: error, message: error.message, retryable: error.retryable }),
                ),
              );
            }),
            { concurrency: "unbounded" },
          ),
        );
        const initialMemory =
          runContext.contextId === null
            ? yield* memoryService
                .freezeContextMemory(runContext, "")
                .pipe(Effect.mapError(failed("Failed to freeze initial context memory")))
            : "";
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
              : await ActiveContext.ensure(transaction, key, chatTools.availableProfile, initialMemory);
            if (context.status !== "active") throw new Error("Pinned context is not active");
            if (context.modelProfileFingerprint !== run.modelProfileFingerprint) {
              throw new Error("Active context profile does not match the prepared run");
            }
            const turns = await transaction.conversationContextTurn.findMany({
              where: { contextId: context.id },
              orderBy: { ordinal: "asc" },
            });
            // Reply-target membership must not depend on the active generation: a hard
            // checkpoint can summarize a target out of the retained tail mid-run. The lane
            // transcript is append-only and stays stable across retries, so D renders
            // byte-identically before and after a checkpoint.
            // One Prisma transaction connection must execute its queries serially.
            // oxlint-disable-next-line react-doctor/server-sequential-independent-await
            const transcriptTurns = await transaction.conversationTranscriptTurn.findMany({
              where: key,
              select: { sourceMessageId: true },
            });
            const knownMessageIds = new Set(
              transcriptTurns.flatMap((turn) => (turn.sourceMessageId === null ? [] : [turn.sourceMessageId])),
            );
            const frozen = Schema.decodeUnknownSync(PreparedRequestSchema)(run.preparedRequest);
            const userMemory = new Map(frozen.userMemory.map((snapshot) => [snapshot.userId, snapshot.text]));
            const renderedMemoryUsers = new Set<string>();
            const current: Model.Message[] = [
              {
                role: "user" as const,
                text: `TRUSTED REQUEST METADATA\nCurrent date: ${frozen.currentDate}`,
              },
              ...run.inputs.flatMap((runInput) => {
                const payload = Schema.decodeUnknownSync(StoredPayloadSchema)(runInput.input.payload);
                const memory =
                  runInput.input.senderUserId === null || renderedMemoryUsers.has(runInput.input.senderUserId)
                    ? []
                    : userMemory.get(runInput.input.senderUserId);
                if (runInput.input.senderUserId !== null) renderedMemoryUsers.add(runInput.input.senderUserId);
                return [
                  ...(memory === undefined
                    ? []
                    : [{ role: "user" as const, text: `${payload.senderFirstName}: ${memory}` }]),
                  {
                    media: loadedMedia.get(runInput.input.id) ?? [],
                    role: "user" as const,
                    text: Prompt.renderLiveMessage(payload, Prompt.describeReplyTarget(payload, knownMessageIds)),
                  },
                ];
              }),
            ];
            const finalized: Model.Message[] = turns.map((turn) => ({
              role: turn.role === "assistant" ? ("assistant" as const) : ("user" as const),
              text: turn.renderedContent,
            }));
            const messages = [...finalized, ...current];
            const cacheBase = context.frozenMemory;
            const envelope = Schema.decodeUnknownSync(Prompt.FrozenEnvelope)(context.stableEnvelope);
            const finalizedTokens = turns.reduce((total, turn) => total + turn.estimatedTokens, 0);
            const currentTokens =
              current.reduce((total, message) => total + Math.ceil(message.text.length / 4), 0) +
              Math.ceil(mediaBytes / 1024);
            const baseTokens = Math.ceil(context.stableEnvelope.length / 4) + Math.ceil(cacheBase.length / 4);
            const terminalPrefixHash = Prompt.verifyPrefix(context.basePrefixHash, turns);
            const messageIdentities = messages.map(messageIdentity);
            const requestHash = new Bun.CryptoHasher("sha256")
              .update(
                Prompt.canonicalEncode({
                  cacheBase,
                  instructions: envelope.instructions,
                  messages: messageIdentities,
                  profileFingerprint: context.modelProfileFingerprint,
                  terminalPrefixHash,
                  toolProfile: envelope.tools,
                }),
              )
              .digest("hex");
            // Region estimates stay local so calibration recording can split A/B/C/D later.
            const prepared = {
              cacheBase,
              contextId: context.id,
              estimatedTokens: baseTokens + finalizedTokens + currentTokens,
              instructions: envelope.instructions,
              messages,
              toolProfile: envelope.tools,
            };
            const snapshot: CacheDiagnostics.PrefixSnapshot = {
              messages: messageIdentities.map((identity) =>
                new Bun.CryptoHasher("sha256").update(Prompt.canonicalEncode(identity)).digest("hex"),
              ),
              settings: `${selected.model}:${selected.reasoning}:${envelope.tools.length > 0}`,
              system: [
                new Bun.CryptoHasher("sha256").update(context.stableEnvelope).digest("hex"),
                new Bun.CryptoHasher("sha256").update(cacheBase).digest("hex"),
              ],
            };
            if (run.requestHash !== null && run.requestHash !== requestHash) {
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
              data: { contextId: context.id, requestHash },
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
        const startedAt = performance.now();
        const prepared = yield* database
          .transaction((client) => prepareCheckpoint(client, checkpointInput))
          .pipe(Effect.mapError(failed("Failed to prepare context checkpoint")));
        if (prepared.kind === "notPossible") {
          OperationalTelemetry.recordDuration("checkpoint", "not-possible", performance.now() - startedAt);
          return yield* new ContextError({ message: prepared.message, retryable: false });
        }
        if (prepared.kind === "committed") {
          OperationalTelemetry.recordDuration("checkpoint", "already-committed", performance.now() - startedAt);
          return prepared.result;
        }

        const summarized = prepared.summary ?? (yield* summarizeCheckpoint(database, model, prepared, checkpointInput));
        const frozenMemory =
          prepared.frozenMemory ??
          (yield* memoryService
            .freezeContextMemory(prepared.key, summarized)
            .pipe(Effect.mapError(failed("Failed to freeze checkpoint memory"))));
        if (prepared.frozenMemory === null) {
          yield* database
            .query((client) =>
              client.conversationCheckpointAttempt.update({
                where: { id: prepared.attemptId },
                data: { frozenMemory },
              }),
            )
            .pipe(Effect.mapError(failed("Failed to persist checkpoint memory")));
        }

        const result = yield* database
          .transaction((client) => commitCheckpoint(client, checkpointInput, prepared, frozenMemory))
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
        OperationalTelemetry.recordDuration("checkpoint", "committed", performance.now() - startedAt);
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
        return yield* checkpoint({ ...checkpointInput, reason: attempt.reason });
      });

      const transitionProfile = Effect.fn("ConversationContext.transitionProfile")(function* transitionProfile(
        input: ProfileTransitionInput,
      ) {
        const key = ConversationKey.toDb(input.key);
        const state = yield* database
          .query((client) =>
            client.conversationLane.findUniqueOrThrow({
              where: { assistantId_chatId_threadKey: key },
              select: { activeContextId: true, contextResetPending: true },
            }),
          )
          .pipe(Effect.mapError(failed("Failed to inspect transitioned context")));
        const frozenMemory =
          state.activeContextId === null || state.contextResetPending
            ? yield* memoryService
                .freezeContextMemory(key, "")
                .pipe(Effect.mapError(failed("Failed to freeze transitioned context memory")))
            : "";
        return yield* database
          .transaction(async (transaction) => {
            await Lane.lockLane(transaction, key);
            if (input.run) await Lane.assertFence(transaction, key, input.run);
            const lane = await transaction.conversationLane.findUniqueOrThrow({
              where: { assistantId_chatId_threadKey: key },
            });
            const profileFingerprint = Prompt.profileFingerprint(input.toolProfile);
            const run = input.run
              ? await transaction.conversationRun.findUniqueOrThrow({ where: { id: input.run.runId } })
              : null;
            const parent = await ActiveContext.ensure(transaction, key, input.toolProfile, frozenMemory);
            const envelope = Prompt.renderEnvelope({
              toolProfile: input.toolProfile,
            });
            if (lane.contextResetPending) {
              await transaction.conversationContext.update({
                where: { id: parent.id },
                data: { activeKey: null, sealedAt: new Date(), status: "invalid" },
              });
              const child = await transaction.conversationContext.create({
                data: {
                  ...key,
                  activeKey: ConversationKey.format(input.key),
                  generation: parent.generation + 1,
                  modelProfileFingerprint: profileFingerprint,
                  parentContextId: parent.id,
                  resetReason: "memory-forget",
                  ...Prompt.stableSeed(envelope, frozenMemory),
                },
              });
              await transaction.conversationLane.update({
                where: { assistantId_chatId_threadKey: key },
                data: { activeContextId: child.id, contextResetPending: false },
              });
              if (input.run) {
                await transaction.conversationRun.update({
                  where: { id: input.run.runId },
                  data: {
                    contextId: child.id,
                    // Frozen revisions stay: rendering drops any whose namespace still
                    // carries an unprocessed forget observation, so other senders keep
                    // their memory instead of losing it until a rebuild republishes.
                    requestHash: null,
                  },
                });
              }
              return { generation: child.generation, id: child.id, profileFingerprint };
            }
            if (run?.contextId) {
              const pinned = await transaction.conversationContext.findUniqueOrThrow({
                where: { id: run.contextId },
              });
              if (pinned.modelProfileFingerprint !== run.modelProfileFingerprint) {
                throw new ContextError({
                  message: "Pinned context profile does not match the prepared run",
                  retryable: false,
                });
              }
              return {
                generation: pinned.generation,
                id: pinned.id,
                profileFingerprint: pinned.modelProfileFingerprint,
              };
            }
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
                activeKey: ConversationKey.format(input.key),
                generation: parent.generation + 1,
                modelProfileFingerprint: profileFingerprint,
                parentContextId: parent.id,
                resetReason: input.reason,
                ...Prompt.stableSeed(envelope, memory),
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
              const role = Transcript.roleByKind[turn.transcriptTurn.kind];
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

  interface ReadyCheckpoint {
    readonly attemptId: string;
    readonly frozenMemory: string | null;
    readonly key: Lane.LaneKey;
    readonly parentContextId: string;
    readonly summary: string | null;
    readonly summaryInput: string;
    readonly tail: readonly Checkpoint.TailTurn[];
  }

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
          // The summary model call is the longest stage in a drain; renew the lane lease so
          // no second worker reclaims the run while summarization is in flight.
          await transaction.conversationLane.update({
            where: { assistantId_chatId_threadKey: prepared.key },
            data: { leaseUntil: new Date(Date.now() + checkpointInput.leaseMs) },
          });
        })
        .pipe(Effect.mapError(failed("Failed to start context summary")));
      const generated = yield* model
        .generate({
          instructions: Checkpoint.summaryInstructions,
          maxOutputTokens: 2048,
          maxToolOutputBytes: 0,
          maxToolSteps: 0,
          messages: [{ role: "user", text: prepared.summaryInput }],
          outputSchema: Checkpoint.Summary,
          sessionId: prepared.parentContextId,
          tools: {},
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
                // TS7 demands index signatures Json columns don't have; the chain
                // is the boundary escape.
                // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- deliberate
                generation: structuredClone(generated.usage) as unknown as Prisma.InputJsonObject,
                // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- deliberate
                steps: structuredClone(generated.steps) as unknown as Prisma.InputJsonArray,
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
  ): Promise<PreparedCheckpoint> {
    const run = await transaction.conversationRun.findUniqueOrThrow({ where: { id: input.runId } });
    const key = { assistantId: run.assistantId, chatId: run.chatId, threadKey: run.threadKey };
    await Lane.assertFence(transaction, key, input);
    if (run.contextId === null) throw new Error("Run has no pinned context");
    const parent = await transaction.conversationContext.findUniqueOrThrow({
      where: { id: run.contextId },
    });
    if (parent.modelProfileFingerprint !== run.modelProfileFingerprint) {
      throw new ContextError({
        message: "Pinned context profile does not match the prepared run",
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
    const boundaries = Checkpoint.resolveBoundary(turns, existing, input.retainedTokenTarget);
    if (boundaries === null) {
      return { kind: "notPossible", message: "Context has no complete head unit to summarize" };
    }
    const summaryInput = existing
      ? existing.summaryInput
      : Prompt.canonicalEncode({
          head: boundaries.head.map((turn) =>
            turn.transcriptTurn.kind === "toolResult" && turn.renderedContent.length > CHECKPOINT_TOOL_OUTPUT_MAX_CHARS
              ? `${turn.renderedContent.slice(0, CHECKPOINT_TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`
              : turn.renderedContent,
          ),
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
    const storedSummary = attempt.summaryOutput ? Checkpoint.Summary.parse(attempt.summaryOutput).summary.trim() : null;

    return {
      kind: "ready",
      attemptId: attempt.id,
      frozenMemory: attempt.frozenMemory,
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
    frozenMemory: string,
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
    await transaction.conversationContext.update({
      where: { id: parent.id },
      data: { activeKey: null },
    });
    const child = await transaction.conversationContext.create({
      data: {
        assistantId: parent.assistantId,
        chatId: parent.chatId,
        threadKey: parent.threadKey,
        activeKey: ConversationKey.format(parent),
        generation: parent.generation + 1,
        modelProfileFingerprint: parent.modelProfileFingerprint,
        parentContextId: parent.id,
        resetReason: input.reason,
        retainedFromTurnOrdinal: attempt.retainedStartTurnOrdinal,
        summaryThroughInputSequence: BigInt(attempt.headEndTurnOrdinal),
        ...Prompt.stableSeed(parent.stableEnvelope, frozenMemory),
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

  function messageIdentity(message: Model.Message) {
    return {
      media: message.media?.map((item) => ({
        mimeType: item.mimeType,
        sha256: item.sha256,
        type: item.type,
      })),
      role: message.role,
      text: message.text,
    };
  }
}

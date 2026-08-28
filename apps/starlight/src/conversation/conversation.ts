import type { ConversationRunStatus, Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect";
import type { Chat as TelegramChat } from "grammy/types";
import { ChatReply } from "@/ai/chat-reply";
import { ChatTools } from "@/ai/chat-tools";
import type { Model } from "@/ai/model";
import { Prompt } from "@/context/prompt";
import { ConversationContext } from "@/context/context";
import { ConversationKey } from "@/conversation/key";
import { Lane } from "@/conversation/lane";
import { PreparedRequestSchema, PreparedToolProfileSchema } from "@/conversation/run-artifacts";
import type { InputPayload } from "@/conversation/run-artifacts";
import { TelegramDelivery } from "@/conversation/delivery";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";
import { context, propagation } from "@opentelemetry/api";

export namespace Conversation {
  const MAX_BATCH_MESSAGES = 20;
  const MAX_ALBUM_MESSAGES = 10;
  const MAX_DELIVERY_ATTEMPTS = 5;
  const MAX_MODEL_ATTEMPTS = 5;
  const MAX_MEMORY_QUERY_CHARS = 4000;
  const CONTEXT_COMPACTION_BUFFER_TOKENS = 20_000;
  const OVERSIZED_INPUT_ERROR_TAG = "oversized-input";
  const ALBUM_SETTLE_MS = 35_000;

  export interface AdmissionInput {
    readonly chatTitle: string | null;
    readonly chatType: TelegramChat["type"];
    readonly chatUsername: string | null;
    readonly key: ConversationKey.Value;
    readonly payload: InputPayload;
    readonly updateId: number;
  }

  export interface AdmissionResult {
    readonly duplicate: boolean;
    readonly inputId: bigint;
    readonly pendingRevision: number;
    readonly wakeAt: Date | null;
  }

  export interface LaneWakeInput {
    readonly key: ConversationKey.Value;
  }

  export interface DrainResult {
    readonly kind: DrainKind;
    readonly runId?: string;
  }

  export type DrainKind = "busy" | "completed" | "not-due" | "up-to-date";

  export class AdmissionError extends Schema.TaggedError<AdmissionError>()("AdmissionError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export class ConversationError extends Schema.TaggedError<ConversationError>()("ConversationError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export interface Interface {
    readonly admit: (input: AdmissionInput) => Effect.Effect<AdmissionResult, AdmissionError>;
    readonly drain: (input: LaneWakeInput) => Effect.Effect<DrainResult, ConversationError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Conversation") {}

  export interface Options {
    readonly contextHardTokenCap: number;
    readonly contextRetainedTokenTarget: number;
    readonly leaseMs: number;
    readonly maxWaitMs: number;
    readonly quietMs: number;
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const database = yield* Database.Service;
      const chatReply = yield* ChatReply.Service;
      const chatTools = yield* ChatTools.Service;
      const conversationContext = yield* ConversationContext.Service;
      const delivery = yield* TelegramDelivery.Service;
      const memory = yield* Memory.Service;
      const options = yield* OptionsService;

      const admit = Effect.fn("Conversation.admit")(function* admit(input: AdmissionInput) {
        const traceCarrier: Record<string, string> = {};
        propagation.inject(context.active(), traceCarrier);
        const traceContext = {
          traceparent: traceCarrier.traceparent ?? null,
          tracestate: traceCarrier.tracestate ?? null,
        };
        const batchQuietMs = input.payload.mediaGroupId === null ? options.quietMs : ALBUM_SETTLE_MS;
        const batchMaxWaitMs = input.payload.mediaGroupId === null ? options.maxWaitMs : ALBUM_SETTLE_MS;
        const mediaReferences =
          input.payload.media.length > 0 || input.payload.repliedMedia.length > 0
            ? { current: input.payload.media, replied: input.payload.repliedMedia }
            : undefined;
        const admitted = yield* database
          .transaction(async (transaction) => {
            const key = ConversationKey.toDb(input.key);
            const sourceRevision = `${
              input.payload.editDate === null ? "original" : "edit"
            }:${input.payload.editDate ?? input.payload.date}:${new Bun.CryptoHasher("sha256")
              .update(Prompt.canonicalEncode(input.payload))
              .digest("hex")}`;
            await transaction.chat.upsert({
              where: { id: BigInt(input.key.chatId) },
              create: {
                id: BigInt(input.key.chatId),
                // Direct messages stay private by default; groups opt in via the flag.
                isPrivate: input.chatType === "private",
                title: input.chatTitle,
                username: input.chatUsername,
              },
              update: { title: input.chatTitle, username: input.chatUsername },
            });
            const sender =
              input.payload.senderId === null
                ? null
                : await transaction.user.upsert({
                    where: { telegramId: BigInt(input.payload.senderId) },
                    create: {
                      firstName: input.payload.senderFirstName,
                      isBot: input.payload.senderIsBot ?? false,
                      lastName: input.payload.senderLastName ?? null,
                      telegramId: BigInt(input.payload.senderId),
                      username: input.payload.senderUsername,
                    },
                    update: {
                      firstName: input.payload.senderFirstName,
                      isBot: input.payload.senderIsBot ?? false,
                      lastName: input.payload.senderLastName ?? null,
                      username: input.payload.senderUsername,
                    },
                  });
            const rawMessage = {
              caption: input.payload.media.length > 0 ? input.payload.text : null,
              chatId: BigInt(input.key.chatId),
              date: new Date(input.payload.date * 1000),
              editDate: input.payload.editDate === null ? null : new Date(input.payload.editDate * 1000),
              forwardOrigin: input.payload.forwardOrigin,
              fromFirstName: input.payload.senderFirstName,
              fromId: input.payload.senderId === null ? null : BigInt(input.payload.senderId),
              fromUsername: input.payload.senderUsername,
              messageId: input.payload.messageId,
              messageThreadId: input.key.threadKey === 0 ? null : input.key.threadKey,
              rawData: input.payload,
              replyToMessageId: input.payload.replyToMessageId,
              text: input.payload.media.length > 0 ? null : input.payload.text,
            };
            await transaction.message.upsert({
              where: {
                messageId_chatId: {
                  chatId: BigInt(input.key.chatId),
                  messageId: input.payload.messageId,
                },
              },
              create: rawMessage,
              update: rawMessage,
            });
            await transaction.conversationLane.upsert({
              where: { assistantId_chatId_threadKey: key },
              create: key,
              update: {},
            });
            // Admission upserts before locking so duplicate detection and revision bookkeeping
            // run under the same lane lock the drain side uses.
            await Lane.lockLane(transaction, key);
            const existing = await transaction.conversationInput.findFirst({
              where: {
                OR: [
                  { assistantId: key.assistantId, sourceUpdateId: input.updateId },
                  {
                    assistantId: key.assistantId,
                    chatId: key.chatId,
                    sourceMessageId: input.payload.messageId,
                    sourceRevision,
                  },
                ],
              },
            });
            if (existing) {
              const outbox = await transaction.conversationWakeOutbox.findUnique({
                where: { assistantId_chatId_threadKey: key },
              });
              return {
                duplicate: true,
                inputId: existing.id,
                pendingRevision: existing.admittedRevision,
                wakeAt: outbox?.desiredWakeAt ?? null,
              };
            }

            const lane = await transaction.conversationLane.findUniqueOrThrow({
              where: { assistantId_chatId_threadKey: key },
            });
            const now = new Date();
            const firstPendingAt = lane.firstPendingAt ?? now;
            const pendingRevision = lane.pendingRevision + 1;
            const wakeAt = new Date(Math.min(now.getTime() + batchQuietMs, firstPendingAt.getTime() + batchMaxWaitMs));
            const created = await transaction.conversationInput.create({
              data: {
                ...key,
                admittedRevision: pendingRevision,
                forwardMetadata: input.payload.forwardOrigin,
                mediaReferences,
                payload: input.payload,
                replyToMessageId: input.payload.replyToMessageId,
                senderTelegramId: input.payload.senderId === null ? null : BigInt(input.payload.senderId),
                senderUserId: sender?.id,
                sourceMessageId: input.payload.messageId,
                sourceRevision,
                sourceUpdateId: input.updateId,
              },
            });
            await transaction.conversationLane.update({
              where: { assistantId_chatId_threadKey: key },
              data: { firstPendingAt, nextWakeAt: wakeAt, pendingRevision },
            });
            await transaction.conversationWakeOutbox.upsert({
              where: { assistantId_chatId_threadKey: key },
              create: {
                ...key,
                desiredWakeAt: wakeAt,
                pendingRevision,
                traceparent: traceContext.traceparent,
                tracestate: traceContext.tracestate,
              },
              update: {
                desiredWakeAt: wakeAt,
                lastError: null,
                pendingRevision,
                publishedAt: null,
                traceparent: traceContext.traceparent,
                tracestate: traceContext.tracestate,
              },
            });

            return { duplicate: false, inputId: created.id, pendingRevision, wakeAt };
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new AdmissionError({
                  cause: error,
                  message: "Failed to admit conversation input",
                  retryable: true,
                }),
            ),
          );

        yield* Effect.logInfo("Conversation input admitted").pipe(
          Effect.annotateLogs({
            conversationKey: ConversationKey.format(input.key),
            duplicate: admitted.duplicate,
            inputId: admitted.inputId.toString(),
            pendingRevision: admitted.pendingRevision,
          }),
        );
        return admitted;
      });

      const drain = Effect.fn("Conversation.drain")(function* drain(input: LaneWakeInput) {
        const claimed = yield* claimRun(input.key);
        if (claimed.kind !== "claimed") return { kind: claimed.kind };

        return yield* Effect.gen(function* drainClaimed() {
          const chat = yield* database
            .query((client) =>
              client.chat.findUnique({
                where: { id: BigInt(claimed.key.chatId) },
                select: { isPremium: true, isPrivate: true, title: true },
              }),
            )
            .pipe(Effect.mapError(failed("Failed to verify chat access")));
          if (!chat?.isPremium) {
            yield* blockRun(claimed, "chat-access-revoked", "Chat access is not allowed");
            return { kind: "completed" as const, runId: claimed.runId };
          }
          const telemetryPrivate = chat.isPrivate;
          const telemetry = {
            telemetryPrivate,
            telemetryTraceName: chat.title ?? undefined,
            telemetryUserId: claimed.inputs.at(-1)?.senderTelegramId?.toString(),
          };
          // A permanent checkpoint failure (e.g. summarization that can never succeed) would
          // otherwise be redriven forever: failed hardSafety attempts are deliberately
          // resumable with no attempt bound.
          const resumedCheckpoint = yield* blockOnPermanent(
            conversationContext.resumeCheckpoint({
              fencingToken: claimed.fencingToken,
              leaseMs: options.leaseMs,
              retainedTokenTarget: options.contextRetainedTokenTarget,
              runId: claimed.runId,
              telemetryPrivate,
            }),
            claimed,
            "checkpoint-failed",
          );
          if (resumedCheckpoint !== null) {
            yield* memory.flush(claimed.dbKey).pipe(Effect.mapError(domainFailed));
          }
          if (claimed.status === "generated" || claimed.status === "dispatching") {
            yield* dispatchRun(claimed);
            return yield* finalizeClaimed(claimed);
          }
          if (claimed.status === "failed") return yield* finalizeClaimed(claimed);
          if (claimed.status === "blocked") {
            // Crash recovery: blockRun releases the lane in the same transaction, so a live claim
            // on a blocked run means it was blocked before that existed. Release the lane instead
            // of failing forever, or every later message stays stuck behind this run.
            yield* finalizeRun(claimed, "blocked");
            yield* Effect.logWarning("Released a lane pinned by a blocked run").pipe(
              Effect.annotateLogs({ runId: claimed.runId }),
            );
            return { kind: "completed" as const, runId: claimed.runId };
          }

          const frozenProfile = Schema.decodeUnknownSync(PreparedToolProfileSchema)(claimed.preparedRequest);
          const transitioned = yield* blockOnPermanent(
            conversationContext.transitionProfile({
              key: claimed.key,
              leaseMs: options.leaseMs,
              profileEnvelope: frozenProfile.profileEnvelope,
              reason: "profile-change",
              retainedTokenTarget: options.contextRetainedTokenTarget,
              run: { fencingToken: claimed.fencingToken, runId: claimed.runId },
              toolProfile: frozenProfile.toolProfile,
              telemetryPrivate,
            }),
            claimed,
            "profile-transition-required",
          );
          if (transitioned.summarized) {
            yield* memory.flush(claimed.dbKey).pipe(Effect.mapError(domainFailed));
          }
          const prepared = yield* prepareRun(claimed, frozenProfile);
          if (!claimed.replyEligible) return yield* finalizeClaimed(claimed);

          let contextRequest = yield* blockOnPermanent(
            conversationContext.prepare({ fencingToken: claimed.fencingToken, runId: claimed.runId }),
            claimed,
            "context-prepare-failed",
          );
          if (exceedsUsableContext(contextRequest, options)) {
            yield* blockOnPermanent(
              conversationContext.checkpoint({
                fencingToken: claimed.fencingToken,
                leaseMs: options.leaseMs,
                reason: "hardSafety",
                retainedTokenTarget: options.contextRetainedTokenTarget,
                runId: claimed.runId,
                telemetryPrivate,
              }),
              claimed,
              OVERSIZED_INPUT_ERROR_TAG,
            );
            yield* memory.flush(claimed.dbKey).pipe(Effect.mapError(domainFailed));
            contextRequest = yield* conversationContext
              .prepare({ fencingToken: claimed.fencingToken, runId: claimed.runId })
              .pipe(Effect.mapError(domainFailed));
            if (exceedsUsableContext(contextRequest, options)) {
              yield* blockRun(
                claimed,
                OVERSIZED_INPUT_ERROR_TAG,
                "Prepared request exceeds the hard context limit after checkpoint",
              );
              return yield* new ConversationError({
                message: "Prepared request exceeds the hard context limit after checkpoint",
                retryable: false,
              });
            }
          }

          const toolset = yield* chatTools.resolve(contextRequest.toolProfile).pipe(Effect.mapError(domainFailed));

          const attempted = yield* invokeModel(claimed, prepared, contextRequest, toolset, {
            allowContextOverflowRecovery: true,
            attemptNumber: claimed.attemptCount + 1,
            ...telemetry,
          });
          const invocation =
            attempted.kind === "contextOverflow"
              ? yield* recoverContextOverflow(claimed, prepared, telemetry)
              : attempted;
          if (invocation.kind === "failed") return yield* finalizeClaimed(claimed);
          if (invocation.kind === "contextOverflow") {
            return yield* new ConversationError({
              message: "Model context limit exceeded after checkpoint",
              retryable: false,
            });
          }

          yield* persistGeneration(claimed, invocation.generated);
          yield* dispatchRun(claimed);
          return yield* finalizeClaimed(claimed);
        }).pipe(Effect.tapError(() => expireLease(claimed)));
      });

      const finalizeClaimed = Effect.fn("Conversation.finalizeClaimed")(function* finalizeClaimed(claimed: ClaimedRun) {
        yield* conversationContext
          .appendFinalized({ fencingToken: claimed.fencingToken, runId: claimed.runId })
          .pipe(Effect.mapError(domainFailed));
        yield* finalizeRun(claimed);
        return { kind: "completed" as const, runId: claimed.runId };
      });

      function blockOnPermanent<A>(
        effect: Effect.Effect<A, ConversationContext.ContextError>,
        claimed: ClaimedRun,
        errorTag: string,
      ): Effect.Effect<A, ConversationError> {
        return effect.pipe(
          Effect.mapError(domainFailed),
          Effect.catch((error) =>
            error.retryable
              ? Effect.fail(error)
              : blockRun(claimed, errorTag, error.message).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
      }

      function claimRun(key: ConversationKey.Value) {
        const toolProfile = chatTools.availableProfile;
        const profileEnvelope = Prompt.renderEnvelope({ toolProfile });
        return database
          .transaction(async (transaction): Promise<ClaimedRun | DrainResult> => {
            const where = ConversationKey.toDb(key);
            await Lane.lockLane(transaction, where);
            const lane = await transaction.conversationLane.findUnique({
              where: { assistantId_chatId_threadKey: where },
            });
            if (!lane || lane.pendingRevision <= lane.processedRevision) return { kind: "up-to-date" };
            const now = new Date();
            if (lane.nextWakeAt && lane.nextWakeAt > now) {
              await transaction.conversationWakeOutbox.updateMany({
                where,
                data: {
                  desiredWakeAt: lane.nextWakeAt,
                  pendingRevision: lane.pendingRevision,
                  publishedAt: null,
                },
              });
              return { kind: "not-due" };
            }
            if (lane.activeRunId && lane.leaseUntil && lane.leaseUntil > now) {
              await transaction.conversationWakeOutbox.updateMany({
                where,
                data: {
                  desiredWakeAt: lane.nextWakeAt ?? now,
                  pendingRevision: lane.pendingRevision,
                  publishedAt: null,
                },
              });
              return { kind: "busy" };
            }

            const fencingToken = lane.fencingToken + 1n;
            const leaseUntil = new Date(now.getTime() + options.leaseMs);
            if (lane.activeRunId) {
              const active = await transaction.conversationRun.findUniqueOrThrow({
                where: { id: lane.activeRunId },
                include: {
                  inputs: { include: { input: true }, orderBy: { ordinal: "asc" } },
                },
              });
              await transaction.conversationRun.update({
                where: { id: active.id },
                data: { fencingToken },
              });
              await transaction.conversationLane.update({
                where: { assistantId_chatId_threadKey: where },
                data: { fencingToken, leaseOwner: crypto.randomUUID(), leaseUntil },
              });
              return {
                fencingToken,
                inputEndRevision: active.inputEndRevision,
                inputs: active.inputs.map((runInput) => runInput.input),
                dbKey: where,
                key,
                kind: "claimed",
                attemptCount: active.attemptCount,
                preparedRequest: active.preparedRequest,
                replyEligible: active.replyEligible,
                runId: active.id,
                status: active.status,
              };
            }

            const pendingInputs = await transaction.conversationInput.findMany({
              where: {
                ...where,
                admittedRevision: {
                  gt: lane.processedRevision,
                  lte: lane.pendingRevision,
                },
              },
              orderBy: { admittedRevision: "asc" },
              take: MAX_BATCH_MESSAGES + MAX_ALBUM_MESSAGES,
            });
            const initialInputs = pendingInputs.slice(0, MAX_BATCH_MESSAGES);
            const finalMediaGroupId = (initialInputs.at(-1)?.payload as InputPayload | undefined)?.mediaGroupId ?? null;
            const mediaGroupTail = pendingInputs.slice(initialInputs.length);
            const mediaGroupEnd = mediaGroupTail.findIndex(
              (item) => (item.payload as InputPayload).mediaGroupId !== finalMediaGroupId,
            );
            const mediaGroupBatchEnd =
              mediaGroupEnd === -1 ? pendingInputs.length : initialInputs.length + mediaGroupEnd;
            const inputs = finalMediaGroupId === null ? initialInputs : pendingInputs.slice(0, mediaGroupBatchEnd);
            const lastInput = inputs.at(-1)!;
            // The eligibility decision is persisted once at freeze time; retries must not
            // recompute (and a future probabilistic policy must not re-roll) it.
            const replyEligible = inputs.some((item) => (item.payload as InputPayload).addressed);
            const run = await transaction.conversationRun.create({
              data: {
                ...where,
                eligibilityReason: "frozen-batch-policy",
                fencingToken,
                inputEndRevision: lastInput.admittedRevision,
                inputStartRevision: inputs[0]!.admittedRevision,
                modelProfileFingerprint: new Bun.CryptoHasher("sha256").update(profileEnvelope).digest("hex"),
                preparedRequest: { profileEnvelope, toolProfile: [...toolProfile] },
                replyEligible,
                inputs: {
                  create: inputs.map((item, ordinal) => ({ inputId: item.id, ordinal })),
                },
              },
            });
            await transaction.conversationInput.updateMany({
              where: { id: { in: inputs.map((item) => item.id) } },
              data: { claimedRunId: run.id },
            });
            await transaction.conversationLane.update({
              where: { assistantId_chatId_threadKey: where },
              data: {
                activeRunId: run.id,
                fencingToken,
                leaseOwner: crypto.randomUUID(),
                leaseUntil,
              },
            });

            return {
              fencingToken,
              inputEndRevision: lastInput.admittedRevision,
              inputs,
              dbKey: where,
              key,
              kind: "claimed",
              attemptCount: 0,
              preparedRequest: { profileEnvelope, toolProfile: [...toolProfile] },
              replyEligible,
              runId: run.id,
              status: "prepared",
            };
          })
          .pipe(Effect.mapError(failed("Failed to claim conversation lane")));
      }

      function prepareRun(claimed: ClaimedRun, frozenProfile: typeof PreparedToolProfileSchema.Type) {
        return Effect.gen(function* prepare() {
          const payloads = claimed.inputs.map((input) => input.payload as InputPayload);
          const stored = Option.getOrNull(Schema.decodeUnknownOption(PreparedRequestSchema)(claimed.preparedRequest));
          // Only what time erodes is frozen; rendering rebuilds deterministically from the
          // immutable batch in ConversationContext.prepare.
          const recalled =
            stored === null
              ? yield* memory
                  .recall({
                    key: claimed.dbKey,
                    query:
                      payloads
                        .map(
                          (payload) =>
                            `${payload.senderFirstName}: ${payload.text}${
                              payload.repliedText === null ? "" : `\nReplied to: ${payload.repliedText}`
                            }`,
                        )
                        .join("\n")
                        .slice(-MAX_MEMORY_QUERY_CHARS) || "Relevant context for the current conversation",
                  })
                  .pipe(Effect.mapError(domainFailed))
              : null;
          const frozen =
            stored ??
            ({
              contextMemory: recalled!.contextMemory,
              currentDate: new Date().toISOString().slice(0, 10),
              profileEnvelope: frozenProfile.profileEnvelope,
              sessionId: new Bun.CryptoHasher("sha256")
                .update(ConversationKey.format(claimed.key))
                .digest("hex")
                .slice(0, 32),
              toolProfile: frozenProfile.toolProfile,
            } satisfies typeof PreparedRequestSchema.Type);
          if (stored === null) {
            yield* database
              .transaction(async (transaction) => {
                await Lane.assertFence(transaction, claimed.dbKey, claimed);
                await transaction.conversationRun.update({
                  where: { id: claimed.runId },
                  data: {
                    modelProfileFingerprint: new Bun.CryptoHasher("sha256")
                      .update(frozen.profileEnvelope)
                      .digest("hex"),
                    preparedRequest: frozen,
                  },
                });
              })
              .pipe(Effect.mapError(failed("Failed to prepare conversation run")));
          }
          return {
            sessionId: frozen.sessionId,
          } satisfies PreparedRun;
        });
      }

      function invokeModel(
        claimed: ClaimedRun,
        prepared: PreparedRun,
        contextRequest: ConversationContext.PreparedContextRequest,
        toolset: ChatTools.Resolved,
        invocation: InvocationOptions,
      ) {
        return Effect.gen(function* invoke() {
          yield* database
            .transaction(async (transaction) => {
              await Lane.assertFence(transaction, claimed.dbKey, claimed);
              await transaction.conversationRun.update({
                where: { id: claimed.runId },
                data: { attemptCount: { increment: 1 }, invokingAt: new Date(), status: "invoking" },
              });
              // Lease renewal rides this stage boundary so the model call cannot outlive the
              // lease and let a second worker re-invoke the same run.
              await transaction.conversationLane.update({
                where: { assistantId_chatId_threadKey: claimed.dbKey },
                data: { leaseUntil: new Date(Date.now() + options.leaseMs) },
              });
            })
            .pipe(Effect.mapError(failed("Failed to start model attempt")));

          yield* delivery.indicateTyping({ chatId: claimed.key.chatId, threadKey: claimed.key.threadKey }).pipe(
            Effect.repeat(Schedule.spaced(Duration.seconds(4))),
            Effect.catch((error) =>
              Effect.logWarning("Failed to send Telegram typing action").pipe(
                Effect.annotateLogs({
                  chatId: claimed.key.chatId,
                  errorTag: error._tag,
                  threadKey: claimed.key.threadKey,
                }),
              ),
            ),
            Effect.forkScoped,
          );

          return yield* chatReply
            .generate({
              cacheBase: contextRequest.cacheBase,
              cachePrefixMessageCount: contextRequest.cachePrefixMessageCount,
              instructions: contextRequest.instructions,
              messages: contextRequest.messages,
              promptCacheKey: contextRequest.contextId,
              private: invocation.telemetryPrivate,
              sessionId: prepared.sessionId,
              telemetryTraceName: invocation.telemetryTraceName,
              telemetryUserId: invocation.telemetryUserId,
              toolset,
            })
            .pipe(
              Effect.map((generated): InvocationResult => ({ generated, kind: "generated" })),
              Effect.catch((error) => {
                if (
                  error._tag === "ContextOverflow" &&
                  invocation.allowContextOverflowRecovery &&
                  invocation.attemptNumber < MAX_MODEL_ATTEMPTS
                ) {
                  return Effect.succeed<InvocationResult>({ kind: "contextOverflow" });
                }
                const exhausted = !error.retryable || invocation.attemptNumber >= MAX_MODEL_ATTEMPTS;
                if (!exhausted) {
                  return recordModelFailure(claimed, error, false).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ConversationError({
                          cause: error,
                          message: "Model generation failed",
                          retryable: true,
                        }),
                      ),
                    ),
                  );
                }
                return recordModelFailure(claimed, error, true).pipe(Effect.as<InvocationResult>({ kind: "failed" }));
              }),
            );
        }).pipe(Effect.scoped);
      }

      function recoverContextOverflow(
        claimed: ClaimedRun,
        prepared: PreparedRun,
        telemetry: Pick<InvocationOptions, "telemetryPrivate" | "telemetryTraceName" | "telemetryUserId">,
      ) {
        return blockOnPermanent(
          conversationContext.checkpoint({
            fencingToken: claimed.fencingToken,
            leaseMs: options.leaseMs,
            reason: "hardSafety",
            retainedTokenTarget: options.contextRetainedTokenTarget,
            runId: claimed.runId,
            telemetryPrivate: telemetry.telemetryPrivate,
          }),
          claimed,
          OVERSIZED_INPUT_ERROR_TAG,
        ).pipe(
          Effect.andThen(memory.flush(claimed.dbKey).pipe(Effect.mapError(domainFailed))),
          Effect.andThen(
            conversationContext
              .prepare({ fencingToken: claimed.fencingToken, runId: claimed.runId })
              .pipe(Effect.mapError(domainFailed)),
          ),
          Effect.flatMap((contextRequest) => {
            if (!exceedsUsableContext(contextRequest, options)) {
              return chatTools.resolve(contextRequest.toolProfile).pipe(
                Effect.mapError(domainFailed),
                Effect.flatMap((toolset) =>
                  invokeModel(claimed, prepared, contextRequest, toolset, {
                    allowContextOverflowRecovery: false,
                    attemptNumber: claimed.attemptCount + 2,
                    ...telemetry,
                  }),
                ),
              );
            }
            const message = "Prepared request exceeds the usable context limit after checkpoint";
            return blockRun(claimed, OVERSIZED_INPUT_ERROR_TAG, message).pipe(
              Effect.andThen(Effect.fail(new ConversationError({ message, retryable: false }))),
            );
          }),
        );
      }

      function persistGeneration(claimed: ClaimedRun, generated: ChatReply.GenerateResult) {
        const transcript: Prisma.InputJsonArray = generated.transcript.map((event) => ({
          text: event.text,
          type: event.type,
        }));
        const usage: Prisma.InputJsonObject = {
          // TS7 demands index signatures Json columns don't have; the chain is the
          // boundary escape.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- deliberate
          generation: structuredClone(generated.usage) as unknown as Prisma.InputJsonObject,
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- deliberate
          steps: structuredClone(generated.steps) as unknown as Prisma.InputJsonArray,
        };
        return database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            const run = await transaction.conversationRun.findUniqueOrThrow({
              where: { id: claimed.runId },
              select: { contextId: true },
            });
            await transaction.conversationToolCall.createMany({
              data: generated.toolEvents.map((event) => ({
                durationMs: event.durationMs,
                errorMessage: event.state === "failed" ? event.errorMessage : null,
                input: event.input as Prisma.InputJsonObject,
                inputHash: new Bun.CryptoHasher("sha256")
                  .update(Prompt.canonicalEncode(event.input as Prisma.InputJsonObject))
                  .digest("hex"),
                providerCallId: event.toolCallId,
                result: event.state === "completed" ? (event.output as Prisma.InputJsonObject) : undefined,
                runId: claimed.runId,
                status: event.state === "completed" ? "completed" : "error",
                toolName: event.toolName,
              })),
              skipDuplicates: true,
            });
            await transaction.conversationRunAction.createMany({
              data: generated.output.replies.map((action, ordinal) => {
                if (action.type === "ignore") {
                  return {
                    deliveryStatus: "delivered" as const,
                    lastError: null,
                    ordinal,
                    payload: action as Prisma.InputJsonObject,
                    runId: claimed.runId,
                    targetMessageId: null,
                    type: action.type,
                  };
                }
                const target = action.type === "reaction" ? action.messageId : action.replyTo;
                return {
                  deliveryStatus: "pending" as const,
                  lastError: null,
                  ordinal,
                  payload: action as Prisma.InputJsonObject,
                  runId: claimed.runId,
                  targetMessageId: target ?? null,
                  type: action.type,
                };
              }),
              skipDuplicates: true,
            });
            await transaction.conversationRun.update({
              where: { id: claimed.runId },
              data: {
                finishReason: generated.finishReason,
                generatedAt: new Date(),
                generatedOutput: generated.output as Prisma.InputJsonObject,
                modelTranscript: transcript,
                status: "generated",
                usage,
              },
            });
            if (run.contextId !== null) {
              await transaction.conversationContext.update({
                where: { id: run.contextId },
                data: {
                  lastObservedCacheReadTokens: generated.steps.at(-1)?.usage.cacheReadTokens,
                  lastObservedInputTokens: generated.usage.contextInputTokens,
                },
              });
            }
          })
          .pipe(
            Effect.withSpan("Conversation generation persist"),
            Effect.mapError(failed("Failed to persist model generation")),
          );
      }

      function dispatchRun(claimed: ClaimedRun) {
        return Effect.gen(function* dispatch() {
          yield* database
            .transaction(async (transaction) => {
              await Lane.assertFence(transaction, claimed.dbKey, claimed);
              await transaction.conversationRun.update({
                where: { id: claimed.runId },
                data: { status: "dispatching" },
              });
              // Same renewal contract as the model stage: Telegram delivery bursts must not
              // outlive the lease while another worker waits on it.
              await transaction.conversationLane.update({
                where: { assistantId_chatId_threadKey: claimed.dbKey },
                data: { leaseUntil: new Date(Date.now() + options.leaseMs) },
              });
            })
            .pipe(Effect.mapError(failed("Failed to start action dispatch")));
          const actions = yield* database
            .query((client) =>
              client.conversationRunAction.findMany({
                where: { runId: claimed.runId },
                orderBy: { ordinal: "asc" },
              }),
            )
            .pipe(Effect.mapError(failed("Failed to load conversation actions")));

          yield* Effect.all(
            actions.map((stored) => {
              if (stored.deliveryStatus === "delivered" || stored.deliveryStatus === "failed") {
                return Effect.void;
              }
              if (stored.deliveryStatus === "unknown" && stored.unknownRetryCount > 0) {
                return failUnknownDelivery(claimed, stored.ordinal);
              }
              return deliverStoredAction(claimed, {
                action: ChatReply.actionSchema.parse(stored.payload),
                attemptCount: stored.attemptCount,
                deliveryStatus: stored.deliveryStatus,
                ordinal: stored.ordinal,
                unknownRetryCount: stored.unknownRetryCount,
              });
            }),
            { concurrency: 1, discard: true },
          );
        });
      }

      function failUnknownDelivery(claimed: ClaimedRun, ordinal: number) {
        return database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            await transaction.conversationRunAction.update({
              where: { runId_ordinal: { ordinal, runId: claimed.runId } },
              data: {
                deliveryStatus: "failed",
                lastError: "Telegram delivery outcome remained unknown after one retry",
              },
            });
          })
          .pipe(Effect.mapError(failed("Failed to finalize unknown Telegram delivery")));
      }

      function deliverStoredAction(
        claimed: ClaimedRun,
        stored: {
          readonly action: TelegramDelivery.Action;
          readonly attemptCount: number;
          readonly deliveryStatus: "pending" | "unknown";
          readonly ordinal: number;
          readonly unknownRetryCount: number;
        },
      ): Effect.Effect<void, ConversationError> {
        return database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            await transaction.conversationRunAction.update({
              where: { runId_ordinal: { ordinal: stored.ordinal, runId: claimed.runId } },
              data: {
                attemptCount: { increment: 1 },
                deliveryStatus: "unknown",
                unknownRetryCount: stored.deliveryStatus === "unknown" ? { increment: 1 } : undefined,
              },
            });
          })
          .pipe(
            Effect.mapError(failed("Failed to record Telegram delivery attempt")),
            Effect.andThen(
              delivery.deliver({
                action: stored.action,
                chatId: claimed.key.chatId,
                threadKey: claimed.key.threadKey,
              }),
            ),
            Effect.flatMap((receipt) =>
              database.transaction(async (transaction) => {
                await Lane.assertFence(transaction, claimed.dbKey, claimed);
                await transaction.conversationRunAction.update({
                  where: { runId_ordinal: { ordinal: stored.ordinal, runId: claimed.runId } },
                  data: {
                    deliveryStatus: "delivered",
                    lastError: null,
                    telegramMessageId: receipt.telegramMessageId,
                  },
                });
              }),
            ),
            Effect.mapError((error) =>
              error instanceof TelegramDelivery.DeliveryError
                ? error
                : new ConversationError({
                    cause: error,
                    message: "Failed to record Telegram delivery",
                    retryable: true,
                  }),
            ),
            Effect.catchTag("DeliveryError", (error) =>
              Effect.gen(function* recover() {
                yield* recordDeliveryFailure(claimed, stored, error, stored.attemptCount + 1 >= MAX_DELIVERY_ATTEMPTS);
                if (
                  error.outcomeUnknown &&
                  stored.deliveryStatus === "pending" &&
                  stored.unknownRetryCount === 0 &&
                  stored.attemptCount + 1 < MAX_DELIVERY_ATTEMPTS
                ) {
                  return yield* deliverStoredAction(claimed, {
                    ...stored,
                    attemptCount: stored.attemptCount + 1,
                    deliveryStatus: "unknown",
                    unknownRetryCount: 1,
                  });
                }
                if (!(error.retryable && !error.outcomeUnknown) || stored.attemptCount + 1 >= MAX_DELIVERY_ATTEMPTS) {
                  return;
                }
                return yield* Effect.fail(
                  new ConversationError({
                    cause: error,
                    message: "Telegram delivery failed",
                    retryable: true,
                  }),
                );
              }),
            ),
          );
      }

      function recordDeliveryFailure(
        claimed: ClaimedRun,
        stored: {
          readonly attemptCount: number;
          readonly deliveryStatus: "pending" | "unknown";
          readonly ordinal: number;
          readonly unknownRetryCount: number;
        },
        error: TelegramDelivery.DeliveryError,
        exhausted: boolean,
      ) {
        return database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            await transaction.conversationRunAction.update({
              where: { runId_ordinal: { ordinal: stored.ordinal, runId: claimed.runId } },
              data: {
                deliveryStatus: (() => {
                  if (exhausted) return "failed";
                  if (error.outcomeUnknown && stored.unknownRetryCount === 0) return "unknown";
                  if (error.outcomeUnknown) return "failed";
                  if (error.retryable) return "pending";
                  return "failed";
                })(),
                lastError: error.message,
              },
            });
          })
          .pipe(Effect.mapError(failed("Failed to record Telegram failure")));
      }

      // Blocking is terminal for the run, so the lane must be released in the same transaction:
      // leaving a blocked run as activeRunId makes every future message reclaim it and fail forever.
      function blockRun(claimed: ClaimedRun, errorTag: string, message: string) {
        return database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            await transaction.conversationRun.update({
              where: { id: claimed.runId },
              data: { errorMessage: message, errorTag, finalizedAt: new Date(), status: "blocked" },
            });
            await releaseLane(transaction, claimed);
          })
          .pipe(Effect.mapError(failed("Failed to block conversation run")));
      }

      function finalizeRun(claimed: ClaimedRun, status?: ConversationRunStatus) {
        return database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            const run = await transaction.conversationRun.findUniqueOrThrow({
              where: { id: claimed.runId },
              select: { status: true },
            });
            await transaction.conversationRun.update({
              where: { id: claimed.runId },
              // The override exists for crash recovery of runs already blocked in an earlier deploy;
              // their status must stay "blocked" instead of being rewritten to "finalized".
              data: { finalizedAt: new Date(), status: status ?? (run.status === "failed" ? "failed" : "finalized") },
            });
            await releaseLane(transaction, claimed);
          })
          .pipe(
            Effect.withSpan("Conversation run finalize"),
            Effect.mapError(failed("Failed to finalize conversation run")),
          );
      }

      // Shared tail of every terminal run transition: clears the lease, advances processedRevision
      // past this run's batch, and schedules the successor wake when newer inputs are waiting.
      async function releaseLane(transaction: Prisma.TransactionClient, claimed: ClaimedRun) {
        const where = claimed.dbKey;
        const lane = await transaction.conversationLane.findUniqueOrThrow({
          where: { assistantId_chatId_threadKey: where },
        });
        const hasSuccessor = lane.pendingRevision > claimed.inputEndRevision;
        const now = new Date();
        const successorWakeAt = hasSuccessor
          ? new Date(now.getTime() + Math.min(options.quietMs, options.maxWaitMs))
          : null;
        await transaction.conversationLane.update({
          where: { assistantId_chatId_threadKey: where },
          data: {
            activeRunId: null,
            firstPendingAt: hasSuccessor ? now : null,
            leaseOwner: null,
            leaseUntil: null,
            nextWakeAt: successorWakeAt,
            processedRevision: claimed.inputEndRevision,
          },
        });
        if (!successorWakeAt) {
          await transaction.conversationWakeOutbox.deleteMany({ where });
          return;
        }
        await transaction.conversationWakeOutbox.upsert({
          where: { assistantId_chatId_threadKey: where },
          create: { ...where, desiredWakeAt: successorWakeAt, pendingRevision: lane.pendingRevision },
          update: {
            desiredWakeAt: successorWakeAt,
            lastError: null,
            pendingRevision: lane.pendingRevision,
            publishedAt: null,
          },
        });
      }

      function recordModelFailure(claimed: ClaimedRun, error: Model.Error, terminal: boolean) {
        return database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            await transaction.conversationRun.update({
              where: { id: claimed.runId },
              data: {
                errorMessage: error.message,
                errorTag: error._tag,
                finalizedAt: null,
                status: terminal ? "failed" : "prepared",
              },
            });
            if (!terminal) {
              await transaction.conversationLane.update({
                where: { assistantId_chatId_threadKey: claimed.dbKey },
                data: { leaseUntil: new Date() },
              });
            }
          })
          .pipe(Effect.mapError(failed("Failed to record model failure")));
      }

      function expireLease(claimed: ClaimedRun) {
        return database
          .query((client) =>
            client.conversationLane.updateMany({
              where: {
                ...claimed.dbKey,
                activeRunId: claimed.runId,
                fencingToken: claimed.fencingToken,
              },
              data: { leaseUntil: new Date() },
            }),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logError("Failed to expire conversation lease").pipe(
                Effect.annotateLogs({ errorTag: error._tag, runId: claimed.runId }),
              ),
            ),
          );
      }

      return Service.of({ admit, drain });
    }),
  );

  export class OptionsService extends Context.Service<OptionsService, Options>()("starlight/ConversationOptions") {}

  export const optionsLayer = Layer.succeed(OptionsService);

  interface ClaimedRun {
    readonly dbKey: Lane.LaneKey;
    readonly fencingToken: bigint;
    readonly inputEndRevision: number;
    readonly inputs: readonly {
      readonly id: bigint;
      readonly payload: unknown;
      readonly senderTelegramId: bigint | null;
      readonly senderUserId: string | null;
    }[];
    readonly key: ConversationKey.Value;
    readonly kind: "claimed";
    readonly attemptCount: number;
    readonly preparedRequest: unknown;
    readonly replyEligible: boolean;
    readonly runId: string;
    readonly status: ConversationRunStatus;
  }

  interface PreparedRun {
    readonly sessionId: string;
  }

  type InvocationResult =
    | { readonly generated: ChatReply.GenerateResult; readonly kind: "generated" }
    | { readonly kind: "contextOverflow" }
    | { readonly kind: "failed" };

  interface InvocationOptions {
    readonly allowContextOverflowRecovery: boolean;
    readonly attemptNumber: number;
    readonly telemetryPrivate: boolean;
    readonly telemetryTraceName?: string;
    readonly telemetryUserId?: string;
  }

  const failed =
    (message: string) =>
    (cause: unknown): ConversationError =>
      new ConversationError({ cause, message, retryable: true });

  function exceedsUsableContext(request: ConversationContext.PreparedContextRequest, options: Options) {
    return (
      request.estimatedTokens >
      Math.max(0, options.contextHardTokenCap - Math.max(ChatReply.maxOutputTokens, CONTEXT_COMPACTION_BUFFER_TOKENS))
    );
  }

  function domainFailed(
    error: ChatTools.ProfileUnavailable | ConversationContext.ContextError | Memory.MemoryError,
  ): ConversationError {
    return new ConversationError({
      cause: error,
      message: error.message,
      retryable: error.retryable,
    });
  }
}

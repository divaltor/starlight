import type { ConversationRunStatus, Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Schema } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import { Model } from "@/ai/model";
import { Prompt } from "@/context/prompt";
import { ConversationContext } from "@/context/context";
import { ConversationKey } from "@/conversation/key";
import { Lane } from "@/conversation/lane";
import { PreparedRequestSchema } from "@/conversation/run-artifacts";
import type { InputPayload } from "@/conversation/run-artifacts";
import { TelegramDelivery } from "@/conversation/delivery";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";
import { Exa } from "@/services/exa";

export namespace Conversation {
  const MAX_BATCH_MESSAGES = 20;
  const MAX_DELIVERY_ATTEMPTS = 5;
  const MAX_MODEL_ATTEMPTS = 5;

  export interface AdmissionInput {
    readonly chatTitle: string | null;
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
    readonly affinitySecret: string;
    readonly contextEstimateSafetyRatio: number;
    readonly contextHardTokenCap: number;
    readonly contextOutputReserveTokens: number;
    readonly contextRetainedTokenTarget: number;
    readonly contextSoftTokenCap: number;
    readonly contextToolReserveTokens: number;
    readonly leaseMs: number;
    readonly maxWaitMs: number;
    readonly quietMs: number;
    readonly whitelistedDmUserIds: readonly number[];
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const database = yield* Database.Service;
      const context = yield* ConversationContext.Service;
      const delivery = yield* TelegramDelivery.Service;
      const exa = yield* Exa.Service;
      const model = yield* Model.Service;
      const memory = yield* Memory.Service;
      const options = yield* OptionsService;
      const whitelistedDmUserIds = new Set(options.whitelistedDmUserIds);

      const admit = Effect.fn("Conversation.admit")(function* admit(input: AdmissionInput) {
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
              caption: null,
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
              text: input.payload.text,
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
            const wakeAt = new Date(
              Math.min(now.getTime() + options.quietMs, firstPendingAt.getTime() + options.maxWaitMs),
            );
            const created = await transaction.conversationInput.create({
              data: {
                ...key,
                admittedRevision: pendingRevision,
                forwardMetadata: input.payload.forwardOrigin,
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
              create: { ...key, desiredWakeAt: wakeAt, pendingRevision },
              update: {
                desiredWakeAt: wakeAt,
                lastError: null,
                pendingRevision,
                publishedAt: null,
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
        const webLookupEnabled = exa.isEnabled();
        const claimed = yield* claimRun(database, input.key, options.leaseMs, webLookupEnabled);
        if (claimed.kind !== "claimed") return { kind: claimed.kind };

        return yield* Effect.gen(function* drainClaimed() {
          if (
            claimed.key.chatId > 0 &&
            claimed.inputs.some(
              (entry) => entry.senderTelegramId === null || !whitelistedDmUserIds.has(Number(entry.senderTelegramId)),
            )
          ) {
            yield* blockRun(
              database,
              claimed,
              options,
              "dm-authorization-revoked",
              "Direct-message access is not allowed",
            );
            return { kind: "completed" as const, runId: claimed.runId };
          }
          yield* context
            .resumeCheckpoint({
              fencingToken: claimed.fencingToken,
              leaseMs: options.leaseMs,
              retainedTokenTarget: options.contextRetainedTokenTarget,
              runId: claimed.runId,
            })
            .pipe(
              Effect.mapError(domainFailed),
              // A permanent checkpoint failure (e.g. summarization that can never succeed) would
              // otherwise be redriven forever: failed hardSafety attempts are deliberately
              // resumable with no attempt bound.
              Effect.catch((error) =>
                error.retryable
                  ? Effect.fail(error)
                  : blockRun(database, claimed, options, "checkpoint-failed", error.message).pipe(
                      Effect.andThen(Effect.fail(error)),
                    ),
              ),
            );
          if (claimed.status === "generated" || claimed.status === "dispatching") {
            yield* dispatchRun(database, delivery, claimed, options);
            yield* appendAndCheckpoint(context, claimed, options);
            yield* finalizeRun(database, claimed, options);
            return { kind: "completed" as const, runId: claimed.runId };
          }
          if (claimed.status === "failed") {
            yield* appendAndCheckpoint(context, claimed, options);
            yield* finalizeRun(database, claimed, options);
            return { kind: "completed" as const, runId: claimed.runId };
          }
          if (claimed.status === "blocked") {
            // Crash recovery: blockRun releases the lane in the same transaction, so a live claim
            // on a blocked run means it was blocked before that existed. Release the lane instead
            // of failing forever, or every later message stays stuck behind this run.
            yield* finalizeRun(database, claimed, options, "blocked");
            yield* Effect.logWarning("Released a lane pinned by a blocked run").pipe(
              Effect.annotateLogs({ runId: claimed.runId }),
            );
            return { kind: "completed" as const, runId: claimed.runId };
          }

          const prepared = yield* prepareRun(database, memory, claimed, options, webLookupEnabled);
          yield* context
            .transitionProfile({
              key: claimed.key,
              reason: "profile-change",
              run: { fencingToken: claimed.fencingToken, runId: claimed.runId },
              webLookupEnabled,
            })
            .pipe(
              Effect.mapError(domainFailed),
              Effect.catch((error) =>
                error.retryable
                  ? Effect.fail(error)
                  : blockRun(database, claimed, options, "profile-transition-required", error.message).pipe(
                      Effect.andThen(Effect.fail(error)),
                    ),
              ),
            );
          if (!claimed.replyEligible) {
            yield* appendAndCheckpoint(context, claimed, options);
            yield* finalizeRun(database, claimed, options);
            return { kind: "completed" as const, runId: claimed.runId };
          }

          let contextRequest = yield* context
            .prepare({ fencingToken: claimed.fencingToken, runId: claimed.runId })
            .pipe(
              Effect.mapError(domainFailed),
              Effect.catch((error) =>
                error.retryable
                  ? Effect.fail(error)
                  : blockRun(database, claimed, options, "context-prepare-failed", error.message).pipe(
                      Effect.andThen(Effect.fail(error)),
                    ),
              ),
            );
          if (projectedTokens(contextRequest, options) >= options.contextHardTokenCap) {
            yield* context
              .checkpoint({
                fencingToken: claimed.fencingToken,
                leaseMs: options.leaseMs,
                reason: "hardSafety",
                retainedTokenTarget: options.contextRetainedTokenTarget,
                runId: claimed.runId,
              })
              .pipe(
                Effect.mapError(domainFailed),
                Effect.catch((error) =>
                  error.retryable
                    ? Effect.fail(error)
                    : blockRun(database, claimed, options, "oversized-input", error.message).pipe(
                        Effect.andThen(Effect.fail(error)),
                      ),
                ),
              );
            contextRequest = yield* context
              .prepare({ fencingToken: claimed.fencingToken, runId: claimed.runId })
              .pipe(Effect.mapError(domainFailed));
            if (projectedTokens(contextRequest, options) >= options.contextHardTokenCap) {
              yield* blockRun(
                database,
                claimed,
                options,
                "oversized-input",
                "Prepared request exceeds the hard context limit after checkpoint",
              );
              return yield* new ConversationError({
                message: "Prepared request exceeds the hard context limit after checkpoint",
                retryable: false,
              });
            }
          }

          const generated = yield* invokeModel(database, claimed, prepared, contextRequest, model, exa, options);
          if (generated === null) {
            yield* appendAndCheckpoint(context, claimed, options);
            yield* finalizeRun(database, claimed, options);
            return { kind: "completed" as const, runId: claimed.runId };
          }

          yield* persistGeneration(database, claimed, generated, prepared.allowedTargetIds);
          yield* dispatchRun(database, delivery, claimed, options);
          yield* appendAndCheckpoint(context, claimed, options);
          yield* finalizeRun(database, claimed, options);
          return { kind: "completed" as const, runId: claimed.runId };
        }).pipe(Effect.tapError(() => expireLease(database, claimed)));
      });

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
    readonly allowedTargetIds: readonly number[];
    readonly sessionId: string;
  }

  const failed =
    (message: string) =>
    (cause: unknown): ConversationError =>
      new ConversationError({ cause, message, retryable: true });

  function claimRun(
    database: Database.Interface,
    key: ConversationKey.Value,
    leaseMs: number,
    webLookupEnabled: boolean,
  ) {
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
        const leaseUntil = new Date(now.getTime() + leaseMs);
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

        const inputs = await transaction.conversationInput.findMany({
          where: {
            ...where,
            admittedRevision: {
              gt: lane.processedRevision,
              lte: lane.pendingRevision,
            },
          },
          orderBy: { admittedRevision: "asc" },
          take: MAX_BATCH_MESSAGES,
        });
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
            modelProfileFingerprint: Prompt.profileFingerprint(webLookupEnabled),
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
          preparedRequest: null,
          replyEligible,
          runId: run.id,
          status: "prepared",
        };
      })
      .pipe(Effect.mapError(failed("Failed to claim conversation lane")));
  }

  function prepareRun(
    database: Database.Interface,
    memory: Memory.Interface,
    claimed: ClaimedRun,
    options: Options,
    webLookupEnabled: boolean,
  ) {
    return Effect.gen(function* prepare() {
      const payloads = claimed.inputs.map((input) => input.payload as InputPayload);
      const allowedTargetIds = [
        ...new Set(
          payloads.flatMap((payload) => [
            payload.messageId,
            ...(payload.replyToMessageId === null ? [] : [payload.replyToMessageId]),
          ]),
        ),
      ];
      const stored =
        claimed.preparedRequest === null
          ? null
          : Schema.decodeUnknownSync(PreparedRequestSchema)(claimed.preparedRequest);
      // Only what time erodes is frozen; rendering rebuilds deterministically from the
      // immutable batch in ConversationContext.prepare.
      const frozen = stored ?? {
        currentDate: new Date().toISOString().slice(0, 10),
        userMemory: yield* memory
          .freezeUserMemory(
            claimed.inputs.flatMap((input) => (input.senderUserId === null ? [] : [input.senderUserId])),
            claimed.dbKey,
          )
          .pipe(Effect.mapError(domainFailed)),
        sessionId: yield* Effect.promise(() => ConversationKey.affinity(claimed.key, options.affinitySecret)),
      };
      if (stored === null) {
        yield* database
          .transaction(async (transaction) => {
            await Lane.assertFence(transaction, claimed.dbKey, claimed);
            await transaction.conversationRun.update({
              where: { id: claimed.runId },
              data: {
                modelProfileFingerprint: Prompt.profileFingerprint(webLookupEnabled),
                preparedRequest: frozen,
              },
            });
          })
          .pipe(Effect.mapError(failed("Failed to prepare conversation run")));
      }
      return { allowedTargetIds, sessionId: frozen.sessionId } satisfies PreparedRun;
    });
  }

  function invokeModel(
    database: Database.Interface,
    claimed: ClaimedRun,
    prepared: PreparedRun,
    contextRequest: ConversationContext.PreparedContextRequest,
    model: Model.Interface,
    exa: Exa.Interface,
    options: Options,
  ) {
    return Effect.gen(function* invoke() {
      if (contextRequest.webLookupEnabled && !exa.isEnabled()) {
        return yield* new ConversationError({
          message: "The pinned context requires web lookup, but the tool is unavailable",
          retryable: true,
        });
      }
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

      return yield* ChatReply.generate({
        cacheBase: contextRequest.cacheBase,
        instructions: contextRequest.instructions,
        messages: contextRequest.messages,
        promptCacheKey: contextRequest.contextId,
        sessionId: prepared.sessionId,
        webLookupEnabled: contextRequest.webLookupEnabled,
      }).pipe(
        Effect.provideService(Model.Service, model),
        Effect.provideService(Exa.Service, exa),
        Effect.catch((error) => {
          const exhausted = !error.retryable || claimed.attemptCount + 1 >= MAX_MODEL_ATTEMPTS;
          if (!exhausted) {
            return recordModelFailure(database, claimed, error, false).pipe(
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
          return recordModelFailure(database, claimed, error, true).pipe(Effect.as(null));
        }),
      );
    });
  }

  function persistGeneration(
    database: Database.Interface,
    claimed: ClaimedRun,
    generated: ChatReply.GenerateResult,
    allowedTargetIds: readonly number[],
  ) {
    const allowedTargets = new Set(allowedTargetIds);
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
            const invalidTarget = target !== null && target !== undefined && !allowedTargets.has(target);
            return {
              deliveryStatus: invalidTarget ? ("failed" as const) : ("pending" as const),
              lastError: invalidTarget ? "Model selected a target outside the frozen batch" : null,
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
      .pipe(Effect.mapError(failed("Failed to persist model generation")));
  }

  function dispatchRun(
    database: Database.Interface,
    delivery: TelegramDelivery.Interface,
    claimed: ClaimedRun,
    options: Options,
  ) {
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
            return database
              .transaction(async (transaction) => {
                await Lane.assertFence(transaction, claimed.dbKey, claimed);
                await transaction.conversationRunAction.update({
                  where: { runId_ordinal: { ordinal: stored.ordinal, runId: claimed.runId } },
                  data: {
                    deliveryStatus: "failed",
                    lastError: "Telegram delivery outcome remained unknown after one retry",
                  },
                });
              })
              .pipe(Effect.mapError(failed("Failed to finalize unknown Telegram delivery")));
          }
          return deliverStoredAction(database, delivery, claimed, {
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

  function deliverStoredAction(
    database: Database.Interface,
    delivery: TelegramDelivery.Interface,
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
            yield* recordDeliveryFailure(
              database,
              claimed,
              stored,
              error,
              stored.attemptCount + 1 >= MAX_DELIVERY_ATTEMPTS,
            );
            if (
              error.outcomeUnknown &&
              stored.deliveryStatus === "pending" &&
              stored.unknownRetryCount === 0 &&
              stored.attemptCount + 1 < MAX_DELIVERY_ATTEMPTS
            ) {
              return yield* deliverStoredAction(database, delivery, claimed, {
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
    database: Database.Interface,
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

  function appendAndCheckpoint(context: ConversationContext.Interface, claimed: ClaimedRun, options: Options) {
    return Effect.gen(function* appendContextAndCheckpoint() {
      const appended = yield* context
        .appendFinalized({ fencingToken: claimed.fencingToken, runId: claimed.runId })
        .pipe(Effect.mapError(domainFailed));
      if (appended.estimatedStableTokens < options.contextSoftTokenCap) return;

      yield* context
        .checkpoint({
          fencingToken: claimed.fencingToken,
          leaseMs: options.leaseMs,
          reason: "softCost",
          retainedTokenTarget: options.contextRetainedTokenTarget,
          runId: claimed.runId,
        })
        .pipe(
          Effect.mapError(domainFailed),
          Effect.catch((error) =>
            Effect.logWarning("Soft context checkpoint failed").pipe(
              Effect.annotateLogs({ errorTag: error._tag, runId: claimed.runId }),
            ),
          ),
        );
    });
  }

  function projectedTokens(request: ConversationContext.PreparedContextRequest, options: Options) {
    return (
      Math.ceil(request.estimatedTokens * options.contextEstimateSafetyRatio) +
      options.contextOutputReserveTokens +
      options.contextToolReserveTokens
    );
  }

  function domainFailed(error: ConversationContext.ContextError | Memory.MemoryError): ConversationError {
    return new ConversationError({
      cause: error,
      message: error.message,
      retryable: error.retryable,
    });
  }

  // Blocking is terminal for the run, so the lane must be released in the same transaction:
  // leaving a blocked run as activeRunId makes every future message reclaim it and fail forever.
  function blockRun(
    database: Database.Interface,
    claimed: ClaimedRun,
    options: Options,
    errorTag: string,
    message: string,
  ) {
    return database
      .transaction(async (transaction) => {
        await Lane.assertFence(transaction, claimed.dbKey, claimed);
        await transaction.conversationRun.update({
          where: { id: claimed.runId },
          data: { errorMessage: message, errorTag, finalizedAt: new Date(), status: "blocked" },
        });
        await releaseLane(transaction, claimed, options);
      })
      .pipe(Effect.mapError(failed("Failed to block conversation run")));
  }

  function finalizeRun(
    database: Database.Interface,
    claimed: ClaimedRun,
    options: Options,
    status?: ConversationRunStatus,
  ) {
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
        await releaseLane(transaction, claimed, options);
      })
      .pipe(Effect.mapError(failed("Failed to finalize conversation run")));
  }

  // Shared tail of every terminal run transition: clears the lease, advances processedRevision
  // past this run's batch, and schedules the successor wake when newer inputs are waiting.
  async function releaseLane(transaction: Prisma.TransactionClient, claimed: ClaimedRun, options: Options) {
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

  function recordModelFailure(
    database: Database.Interface,
    claimed: ClaimedRun,
    error: Model.Error,
    terminal: boolean,
  ) {
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

  function expireLease(database: Database.Interface, claimed: ClaimedRun) {
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
}

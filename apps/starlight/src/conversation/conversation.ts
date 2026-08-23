import type { ConversationRunStatus, Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Schema } from "effect";
import * as ChatReply from "@/ai/chat-reply";
import * as Model from "@/ai/model";
import { extractAllowedUrls } from "@/ai/tools/web";
import * as Prompt from "@/context/prompt";
import * as ConversationContext from "@/context/context";
import * as ConversationKey from "@/conversation/key";
import * as TelegramDelivery from "@/conversation/delivery";
import * as Database from "@/services/database";
import * as Exa from "@/services/exa";

const MAX_BATCH_MESSAGES = 20;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_MODEL_ATTEMPTS = 5;

export interface InputPayload extends Prisma.InputJsonObject {
  readonly addressed: boolean;
  readonly date: number;
  readonly editDate: number | null;
  readonly forwardOrigin: string | null;
  readonly messageId: number;
  readonly replyToMessageId: number | null;
  readonly repliedText: string | null;
  readonly senderFirstName: string;
  readonly senderId: number | null;
  readonly senderUsername: string | null;
  readonly text: string;
}

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
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* layer() {
    const database = yield* Database.Service;
    const context = yield* ConversationContext.Service;
    const delivery = yield* TelegramDelivery.Service;
    const exa = yield* Exa.Service;
    const model = yield* Model.Service;
    const options = yield* OptionsService;

    const admit = Effect.fn("Conversation.admit")(function* admit(input: AdmissionInput) {
      const admitted = yield* database
        .transaction(async (transaction) => {
          const key = dbKey(input.key);
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
          await transaction.$queryRaw`
						SELECT 1 FROM conversation_lanes
						WHERE assistant_id = ${key.assistantId}
							AND chat_id = ${key.chatId}
							AND thread_key = ${key.threadKey}
						FOR UPDATE
					`;
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
          conversationKey: `v1/${input.key.assistantId}/${input.key.chatId}/${input.key.threadKey}`,
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
        yield* context
          .resumeCheckpoint({
            fencingToken: claimed.fencingToken,
            retainedTokenTarget: options.contextRetainedTokenTarget,
            runId: claimed.runId,
          })
          .pipe(Effect.mapError(contextFailed));
        if (claimed.status === "generated" || claimed.status === "dispatching") {
          yield* dispatchRun(database, delivery, claimed);
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
          return yield* new ConversationError({
            message: claimed.errorMessage ?? "Conversation run is blocked",
            retryable: false,
          });
        }

        const prepared = yield* prepareRun(database, claimed, options, webLookupEnabled);
        yield* context
          .transitionProfile({
            key: claimed.key,
            reason: "profile-change",
            run: { fencingToken: claimed.fencingToken, runId: claimed.runId },
            webLookupEnabled,
          })
          .pipe(
            Effect.mapError(contextFailed),
            Effect.catch((error) =>
              error.retryable
                ? Effect.fail(error)
                : blockRun(database, claimed, "profile-transition-required", error.message).pipe(
                    Effect.andThen(Effect.fail(error)),
                  ),
            ),
          );
        if (!prepared.replyEligible) {
          yield* appendAndCheckpoint(context, claimed, options);
          yield* finalizeRun(database, claimed, options);
          return { kind: "completed" as const, runId: claimed.runId };
        }

        let contextRequest = yield* context.prepare({ fencingToken: claimed.fencingToken, runId: claimed.runId }).pipe(
          Effect.mapError(contextFailed),
          Effect.catch((error) =>
            error.retryable
              ? Effect.fail(error)
              : blockRun(database, claimed, "profile-transition-required", error.message).pipe(
                  Effect.andThen(Effect.fail(error)),
                ),
          ),
        );
        if (projectedTokens(contextRequest, options) >= options.contextHardTokenCap) {
          yield* context
            .checkpoint({
              fencingToken: claimed.fencingToken,
              reason: "hardSafety",
              retainedTokenTarget: options.contextRetainedTokenTarget,
              runId: claimed.runId,
            })
            .pipe(
              Effect.mapError(contextFailed),
              Effect.catch((error) =>
                error.retryable
                  ? Effect.fail(error)
                  : blockRun(database, claimed, "oversized-input", error.message).pipe(
                      Effect.andThen(Effect.fail(error)),
                    ),
              ),
            );
          contextRequest = yield* context
            .prepare({ fencingToken: claimed.fencingToken, runId: claimed.runId })
            .pipe(Effect.mapError(contextFailed));
          if (projectedTokens(contextRequest, options) >= options.contextHardTokenCap) {
            yield* blockRun(
              database,
              claimed,
              "oversized-input",
              "Prepared request exceeds the hard context limit after checkpoint",
            );
            return yield* new ConversationError({
              message: "Prepared request exceeds the hard context limit after checkpoint",
              retryable: false,
            });
          }
        }

        const generated = yield* invokeModel(database, claimed, prepared, contextRequest, model, exa);
        if (generated === null) {
          yield* appendAndCheckpoint(context, claimed, options);
          yield* finalizeRun(database, claimed, options);
          return { kind: "completed" as const, runId: claimed.runId };
        }

        yield* persistGeneration(database, claimed, generated, prepared.allowedTargetIds);
        yield* dispatchRun(database, delivery, claimed);
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
  readonly errorMessage: string | null;
  readonly fencingToken: bigint;
  readonly inputEndRevision: number;
  readonly inputs: readonly {
    readonly id: bigint;
    readonly payload: Prisma.JsonValue;
  }[];
  readonly key: ConversationKey.Value;
  readonly kind: "claimed";
  readonly attemptCount: number;
  readonly preparedRequest: Prisma.JsonValue | null;
  readonly runId: string;
  readonly status: ConversationRunStatus;
}

interface PreparedRun {
  readonly allowedTargetIds: readonly number[];
  readonly allowedUrls: readonly string[];
  readonly messages: readonly Model.Message[];
  readonly replyEligible: boolean;
  readonly sessionId: string;
}

const failed =
  (message: string) =>
  (cause: unknown): ConversationError =>
    new ConversationError({ cause, message, retryable: true });

function dbKey(key: ConversationKey.Value) {
  return {
    assistantId: BigInt(key.assistantId),
    chatId: BigInt(key.chatId),
    threadKey: key.threadKey,
  };
}

function claimRun(
  database: Database.Interface,
  key: ConversationKey.Value,
  leaseMs: number,
  webLookupEnabled: boolean,
) {
  return database
    .transaction(async (transaction): Promise<ClaimedRun | DrainResult> => {
      const where = dbKey(key);
      await transaction.$queryRaw`
				SELECT 1 FROM conversation_lanes
				WHERE assistant_id = ${where.assistantId}
					AND chat_id = ${where.chatId}
					AND thread_key = ${where.threadKey}
				FOR UPDATE
			`;
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
          errorMessage: active.errorMessage,
          fencingToken,
          inputEndRevision: active.inputEndRevision,
          inputs: active.inputs.map((runInput) => runInput.input),
          key,
          kind: "claimed",
          attemptCount: active.attemptCount,
          preparedRequest: active.preparedRequest,
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
      const run = await transaction.conversationRun.create({
        data: {
          ...where,
          eligibilityReason: "frozen-batch-policy",
          fencingToken,
          inputEndRevision: lastInput.admittedRevision,
          inputStartRevision: inputs[0]!.admittedRevision,
          modelProfileFingerprint: Prompt.profileFingerprint(webLookupEnabled),
          replyEligible: inputs.some((item) => (item.payload as InputPayload).addressed),
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
        errorMessage: null,
        fencingToken,
        inputEndRevision: lastInput.admittedRevision,
        inputs,
        key,
        kind: "claimed",
        attemptCount: 0,
        preparedRequest: null,
        runId: run.id,
        status: "prepared",
      };
    })
    .pipe(Effect.mapError(failed("Failed to claim conversation lane")));
}

function prepareRun(database: Database.Interface, claimed: ClaimedRun, options: Options, webLookupEnabled: boolean) {
  return Effect.gen(function* prepare() {
    if (claimed.preparedRequest !== null) {
      return Schema.decodeUnknownSync(PreparedRunSchema)(claimed.preparedRequest);
    }
    const payloads = claimed.inputs.map((input) => input.payload as InputPayload);
    const currentDate = new Date().toISOString().slice(0, 10);
    const messages = [
      {
        role: "user" as const,
        text: `TRUSTED REQUEST METADATA\nCurrent date: ${currentDate}`,
      },
      ...payloads.map((payload) => ({
        role: "user" as const,
        text: Prompt.renderLiveMessage(payload, (replyToMessageId) =>
          payload.repliedText
            ? `REPLIED MESSAGE #${replyToMessageId}: ${payload.repliedText}\n`
            : `REPLIED MESSAGE #${replyToMessageId}: [target unavailable]\n`,
        ),
      })),
    ];
    const allowedTargetIds = payloads.flatMap((payload) => [
      payload.messageId,
      ...(payload.replyToMessageId === null ? [] : [payload.replyToMessageId]),
    ]);
    const prepared = {
      allowedTargetIds: [...new Set(allowedTargetIds)],
      allowedUrls: extractAllowedUrls(payloads.map((payload) => payload.text).join("\n")),
      messages,
      replyEligible: payloads.some((payload) => payload.addressed),
      sessionId: yield* Effect.promise(() => ConversationKey.affinity(claimed.key, options.affinitySecret)),
    } satisfies PreparedRun;
    const request = {
      ...prepared,
      currentDate,
      profileFingerprint: Prompt.profileFingerprint(webLookupEnabled),
    };

    yield* database
      .transaction(async (transaction) => {
        await assertFence(transaction, claimed);
        await transaction.conversationRun.update({
          where: { id: claimed.runId },
          data: {
            modelProfileFingerprint: request.profileFingerprint,
            preparedRequest: request,
          },
        });
      })
      .pipe(Effect.mapError(failed("Failed to prepare conversation run")));
    return prepared;
  });
}

function invokeModel(
  database: Database.Interface,
  claimed: ClaimedRun,
  prepared: PreparedRun,
  contextRequest: ConversationContext.PreparedContextRequest,
  model: Model.Interface,
  exa: Exa.Interface,
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
        await assertFence(transaction, claimed);
        await transaction.conversationRun.update({
          where: { id: claimed.runId },
          data: { attemptCount: { increment: 1 }, invokingAt: new Date(), status: "invoking" },
        });
      })
      .pipe(Effect.mapError(failed("Failed to start model attempt")));

    return yield* ChatReply.generate({
      allowedUrls: prepared.allowedUrls,
      cacheBase: contextRequest.cacheBase,
      instructions: contextRequest.instructions,
      messages: contextRequest.messages,
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
    generation: structuredClone(generated.usage) as Prisma.InputJsonObject,
    steps: structuredClone(generated.steps) as Prisma.InputJsonArray,
  };
  return database
    .transaction(async (transaction) => {
      await assertFence(transaction, claimed);
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
          const target = action.type === "reaction" ? action.messageId : action.replyTo;
          const invalidTarget = target !== null && target !== undefined && !allowedTargets.has(target);
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

function dispatchRun(database: Database.Interface, delivery: TelegramDelivery.Interface, claimed: ClaimedRun) {
  return Effect.gen(function* dispatch() {
    yield* database
      .transaction(async (transaction) => {
        await assertFence(transaction, claimed);
        await transaction.conversationRun.update({
          where: { id: claimed.runId },
          data: { status: "dispatching" },
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
              await assertFence(transaction, claimed);
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
      await assertFence(transaction, claimed);
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
          await assertFence(transaction, claimed);
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
      await assertFence(transaction, claimed);
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
      .pipe(Effect.mapError(contextFailed));
    if (appended.estimatedStableTokens < options.contextSoftTokenCap) return;

    yield* context
      .checkpoint({
        fencingToken: claimed.fencingToken,
        reason: "softCost",
        retainedTokenTarget: options.contextRetainedTokenTarget,
        runId: claimed.runId,
      })
      .pipe(
        Effect.mapError(contextFailed),
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
    Math.ceil(request.estimatedTokens.total * options.contextEstimateSafetyRatio) +
    options.contextOutputReserveTokens +
    options.contextToolReserveTokens
  );
}

function contextFailed(error: ConversationContext.ContextError): ConversationError {
  return new ConversationError({
    cause: error,
    message: error.message,
    retryable: error.retryable,
  });
}

function blockRun(database: Database.Interface, claimed: ClaimedRun, errorTag: string, message: string) {
  return database
    .transaction(async (transaction) => {
      await assertFence(transaction, claimed);
      await transaction.conversationRun.update({
        where: { id: claimed.runId },
        data: { errorMessage: message, errorTag, status: "blocked" },
      });
    })
    .pipe(Effect.mapError(failed("Failed to block oversized conversation run")));
}

function finalizeRun(database: Database.Interface, claimed: ClaimedRun, options: Options) {
  return database
    .transaction(async (transaction) => {
      await assertFence(transaction, claimed);
      const where = dbKey(claimed.key);
      const lane = await transaction.conversationLane.findUniqueOrThrow({
        where: { assistantId_chatId_threadKey: where },
      });
      const hasSuccessor = lane.pendingRevision > claimed.inputEndRevision;
      const now = new Date();
      const successorWakeAt = hasSuccessor
        ? new Date(now.getTime() + Math.min(options.quietMs, options.maxWaitMs))
        : null;
      const run = await transaction.conversationRun.findUniqueOrThrow({
        where: { id: claimed.runId },
        select: { status: true },
      });
      await transaction.conversationRun.update({
        where: { id: claimed.runId },
        data: { finalizedAt: now, status: run.status === "failed" ? "failed" : "finalized" },
      });
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
        create: {
          ...where,
          desiredWakeAt: successorWakeAt,
          pendingRevision: lane.pendingRevision,
        },
        update: {
          desiredWakeAt: successorWakeAt,
          lastError: null,
          pendingRevision: lane.pendingRevision,
          publishedAt: null,
        },
      });
    })
    .pipe(Effect.mapError(failed("Failed to finalize conversation run")));
}

function recordModelFailure(database: Database.Interface, claimed: ClaimedRun, error: Model.Error, terminal: boolean) {
  return database
    .transaction(async (transaction) => {
      await assertFence(transaction, claimed);
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
          where: { assistantId_chatId_threadKey: dbKey(claimed.key) },
          data: { leaseUntil: new Date() },
        });
      }
    })
    .pipe(Effect.mapError(failed("Failed to record model failure")));
}

async function assertFence(transaction: Prisma.TransactionClient, claimed: ClaimedRun) {
  const key = dbKey(claimed.key);
  await transaction.$queryRaw`
		SELECT 1 FROM conversation_lanes
		WHERE assistant_id = ${key.assistantId}
			AND chat_id = ${key.chatId}
			AND thread_key = ${key.threadKey}
		FOR UPDATE
	`;
  const lane = await transaction.conversationLane.findUnique({
    where: { assistantId_chatId_threadKey: key },
    select: { activeRunId: true, fencingToken: true },
  });
  if (lane?.activeRunId !== claimed.runId || lane.fencingToken !== claimed.fencingToken) {
    throw new Error("Conversation lane fence is stale");
  }
}

const PreparedRunSchema = Schema.Struct({
  allowedTargetIds: Schema.Array(Schema.Int),
  allowedUrls: Schema.Array(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["assistant", "user"]),
      text: Schema.String,
    }),
  ),
  replyEligible: Schema.Boolean,
  sessionId: Schema.String,
});

function expireLease(database: Database.Interface, claimed: ClaimedRun) {
  return database
    .query((client) =>
      client.conversationLane.updateMany({
        where: {
          ...dbKey(claimed.key),
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

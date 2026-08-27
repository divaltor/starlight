import type { Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { Prompt } from "@/context/prompt";
import { Lane } from "@/conversation/lane";
import { InputPayloadSchema } from "@/conversation/run-artifacts";
import type { FrozenUserMemory } from "@/conversation/run-artifacts";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { OperationalTelemetry } from "@/operational-telemetry";
import { Database } from "@/services/database";

export namespace Memory {
  const MAX_CONTEXT_MEMORY_CHARS = 3200;
  const MAX_USER_MEMORY_SENDERS = 3;
  const MAX_USER_MEMORY_CHARS = 1600;
  const RECALL_MAX_TOKENS = 800;

  export interface ForgetInput {
    readonly firstName: string;
    readonly isBot: boolean;
    readonly lastName: string | null;
    readonly request: string;
    readonly telegramId: number;
    readonly username: string | null;
  }

  export interface ForgetResult {
    readonly affectedLanes: number;
    readonly observations: number;
  }

  export interface RecallInput {
    readonly key: Lane.LaneKey;
    readonly query: string;
    readonly userIds: readonly string[];
  }

  export interface Recalled {
    readonly contextMemory: string | null;
    readonly userMemory: readonly FrozenUserMemory[];
  }

  export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export interface Interface {
    readonly forget: (input: ForgetInput) => Effect.Effect<ForgetResult, MemoryError>;
    readonly recall: (input: RecallInput) => Effect.Effect<Recalled, MemoryError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Memory") {}

  export const layer: Layer.Layer<Service, never, Database.Service | Hindsight.Service | HindsightRetention.Service> =
    Layer.effect(
      Service,
      Effect.gen(function* layer() {
        const database = yield* Database.Service;
        const hindsight = yield* Hindsight.Service;
        const retention = yield* HindsightRetention.Service;

        const recall = Effect.fn("Memory.recall")(function* recall(input: RecallInput) {
          const selectedUserIds = [...new Set(input.userIds)].slice(0, MAX_USER_MEMORY_SENDERS);
          const contextOwnerKeys =
            input.key.chatId < 0n
              ? [`chat:${input.key.chatId}`, `topic:${input.key.chatId}:${input.key.threadKey}`]
              : [];
          const namespaces = yield* database
            .query((client) =>
              client.memoryNamespace.findMany({
                where: {
                  OR: [{ kind: "user", userId: { in: selectedUserIds } }, { ownerKey: { in: contextOwnerKeys } }],
                },
                include: {
                  observations: {
                    where: { kind: { not: "forget" } },
                    distinct: ["sourceChatId", "sourceThreadKey", "visibility"],
                    select: { sourceChatId: true, sourceThreadKey: true, visibility: true },
                  },
                },
              }),
            )
            .pipe(Effect.mapError(failed("Failed to find relevant memory namespaces")));
          const latestByNamespace = yield* database
            .query((client) =>
              client.memoryObservation.groupBy({
                by: ["namespaceId"],
                where: { namespaceId: { in: namespaces.map((namespace) => namespace.id) } },
                _max: { id: true },
              }),
            )
            .pipe(Effect.mapError(failed("Failed to find pending relevant memory")));
          yield* Effect.all(
            latestByNamespace.map((latest) =>
              retention
                .retainThrough(latest.namespaceId, latest._max.id!)
                .pipe(Effect.mapError(failed("Failed to synchronize relevant memory"))),
            ),
            { concurrency: 3, discard: true },
          );

          const userTargets = namespaces.flatMap((namespace) => {
            if (namespace.kind !== "user" || namespace.userId === null) return [];
            const bankIds = [
              ...new Set(
                namespace.observations.flatMap((observation) => {
                  if (
                    input.key.chatId > 0n &&
                    !["privateUser", "sameChat", "publicProfile", "explicitShareable"].includes(observation.visibility)
                  )
                    return [];
                  if (input.key.chatId < 0n && observation.visibility === "privateUser") return [];
                  if (
                    input.key.chatId < 0n &&
                    observation.visibility === "sameChat" &&
                    observation.sourceChatId !== input.key.chatId
                  )
                    return [];
                  if (
                    input.key.chatId < 0n &&
                    observation.visibility === "sameTopic" &&
                    (observation.sourceChatId !== input.key.chatId ||
                      observation.sourceThreadKey !== input.key.threadKey)
                  )
                    return [];
                  return [HindsightRetention.bankFor(namespace, observation)];
                }),
              ),
            ].toSorted();
            if (bankIds.length < namespace.observations.length) {
              OperationalTelemetry.recordEvent("memory-projection", "privacy-filtered");
            }
            return bankIds.map((bankId) => ({ bankId, kind: namespace.kind, userId: namespace.userId }));
          });
          const contextTargets = namespaces.flatMap((namespace) =>
            namespace.kind === "user" || namespace.observations.length === 0
              ? []
              : [{ bankId: namespace.ownerKey, kind: namespace.kind, userId: null }],
          );
          const targets = [
            ...new Map(
              [...userTargets, ...contextTargets].map((target) => [
                `${target.userId ?? "context"}:${target.bankId}`,
                target,
              ]),
            ).values(),
          ];
          const recalled = yield* Effect.all(
            targets.map((target) =>
              hindsight
                .recall({ bankId: target.bankId, maxTokens: RECALL_MAX_TOKENS, query: input.query })
                .pipe(Effect.map((results) => ({ ...target, results }))),
            ),
            { concurrency: 3 },
          ).pipe(Effect.mapError(failed("Failed to recall Hindsight memory")));

          const contextSeen = new Set<string>();
          const contextScopes: Prompt.MemoryInput["scopes"][number][] = [];
          const seenByUserId = new Map(selectedUserIds.map((userId) => [userId, new Set<string>()]));
          const scopesByUserId = new Map(
            selectedUserIds.map((userId) => [userId, [] as { readonly bankId: string; readonly memory: string }[]]),
          );
          for (const item of recalled.toSorted(
            (left, right) => Number(right.kind === "topic") - Number(left.kind === "topic"),
          )) {
            const seen = item.userId === null ? contextSeen : seenByUserId.get(item.userId)!;
            const lines: string[] = [];
            for (const result of item.results) {
              if (seen.has(result.text)) continue;
              seen.add(result.text);
              lines.push(`- ${result.text}`);
            }
            if (lines.length > 0 && item.userId === null) {
              contextScopes.push({ kind: item.kind, memory: lines.join("\n") });
            }
            if (lines.length > 0 && item.userId !== null) {
              scopesByUserId.get(item.userId)!.push({ bankId: item.bankId, memory: lines.join("\n") });
            }
          }
          const contextMemory =
            contextScopes.length === 0
              ? null
              : Prompt.renderMemory({ checkpoint: "", scopes: contextScopes }).slice(0, MAX_CONTEXT_MEMORY_CHARS);
          const userMemory = selectedUserIds.flatMap((userId): readonly FrozenUserMemory[] => {
            const text = renderUserMemory(scopesByUserId.get(userId)!);
            return text === null ? [] : [{ text, userId }];
          });
          return { contextMemory, userMemory };
        });

        const forget = Effect.fn("Memory.forget")(function* forget(input: ForgetInput) {
          const startedAt = performance.now();
          const result = yield* database
            .transaction(async (transaction) => {
              const user = await transaction.user.upsert({
                where: { telegramId: BigInt(input.telegramId) },
                create: {
                  firstName: input.firstName,
                  isBot: input.isBot,
                  lastName: input.lastName,
                  telegramId: BigInt(input.telegramId),
                  username: input.username,
                },
                update: {
                  firstName: input.firstName,
                  isBot: input.isBot,
                  lastName: input.lastName,
                  username: input.username,
                },
              });
              const userNamespace = await transaction.memoryNamespace.upsert({
                where: { ownerKey: `user:${user.id}` },
                create: { kind: "user", ownerKey: `user:${user.id}`, userId: user.id },
                update: {},
              });
              const relatedNamespaces = await transaction.memoryNamespace.findMany({
                where: { OR: [{ id: userNamespace.id }, { observations: { some: { subjectUserId: user.id } } }] },
                select: {
                  chatId: true,
                  id: true,
                  kind: true,
                  observations: {
                    where: { kind: { not: "forget" }, subjectUserId: user.id },
                    select: { sourceChatId: true, sourceThreadKey: true, visibility: true },
                  },
                  ownerKey: true,
                  userId: true,
                },
              });
              const namespaces = [...new Set(relatedNamespaces.map((namespace) => namespace.id))];
              const affectedBankIds = [
                ...new Set(
                  relatedNamespaces.flatMap((namespace) =>
                    namespace.observations.map(HindsightRetention.bankFor.bind(null, namespace)),
                  ),
                ),
              ];
              const affectedChatIds = [
                ...new Set(
                  relatedNamespaces.flatMap((namespace) => (namespace.chatId === null ? [] : [namespace.chatId])),
                ),
              ];
              const lanes = await transaction.conversationLane.findMany({
                where: {
                  OR: [
                    { inputs: { some: { senderUserId: user.id } } },
                    ...(affectedChatIds.length === 0 ? [] : [{ chatId: { in: affectedChatIds } }]),
                  ],
                },
                orderBy: [{ assistantId: "asc" }, { chatId: "asc" }, { threadKey: "asc" }],
              });
              const lockedLanes: { readonly activeRunId: string | null }[] = [];
              for (const lane of lanes) {
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                lockedLanes.push(await Lane.lockLane(transaction, lane));
              }
              if (lockedLanes.some((lane) => lane.activeRunId !== null)) throw new ForgetBusyError();
              await transaction.memoryProfileSnapshot.deleteMany({ where: { bankId: { in: affectedBankIds } } });
              const markers: { readonly id: bigint; readonly namespaceId: string }[] = [];
              for (const namespaceId of namespaces) {
                // The markers must be ordered and returned so deletion completes before confirmation.
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                const observation = await transaction.memoryObservation.create({
                  data: {
                    content: { request: input.request },
                    kind: "forget",
                    namespaceId,
                    sourceChatId: BigInt(input.telegramId),
                    sourceThreadKey: 0,
                    subjectUserId: user.id,
                    visibility: "privateUser",
                  },
                });
                markers.push({ id: observation.id, namespaceId });
              }
              const affected = await transaction.conversationLane.updateMany({
                where: {
                  OR: lanes.map((lane) => ({
                    assistantId: lane.assistantId,
                    chatId: lane.chatId,
                    threadKey: lane.threadKey,
                  })),
                },
                data: { contextResetPending: true },
              });
              return { affectedLanes: affected.count, markers };
            })
            .pipe(
              Effect.mapError((error) =>
                error.cause instanceof ForgetBusyError
                  ? new MemoryError({
                      cause: error,
                      message: "Waiting for active conversation runs before forgetting memory",
                      retryable: true,
                    })
                  : failed("Failed to record memory forget request")(error),
              ),
              Effect.retry({
                schedule: Schedule.spaced(Duration.millis(250)),
                times: 720,
                while: (error) =>
                  error.cause instanceof Database.TransactionError && error.cause.cause instanceof ForgetBusyError,
              }),
            );
          yield* Effect.all(
            result.markers.map((marker) =>
              retention
                .retainThrough(marker.namespaceId, marker.id)
                .pipe(Effect.mapError(failed("Failed to erase Hindsight memory"))),
            ),
            { concurrency: 3, discard: true },
          );
          yield* Effect.logInfo("Memory forget completed").pipe(
            Effect.annotateLogs({ affectedLanes: result.affectedLanes, observations: result.markers.length }),
          );
          OperationalTelemetry.recordDuration("forget", "completed", performance.now() - startedAt);
          return { affectedLanes: result.affectedLanes, observations: result.markers.length };
        });

        return Service.of({ forget, recall });
      }),
    );

  export async function recordFinalized(
    transaction: Prisma.TransactionClient,
    run: Prisma.ConversationRunGetPayload<{ include: { inputs: { include: { input: true } } } }>,
  ): Promise<void> {
    for (const runInput of run.inputs) {
      const { input } = runInput;
      const payload = Schema.decodeUnknownSync(InputPayloadSchema)(input.payload);
      const kind = payload.editDate === null ? "fact" : "correction";
      const content = {
        addressed: payload.addressed,
        author: {
          firstName: payload.senderFirstName,
          isBot: payload.senderIsBot ?? false,
          lastName: payload.senderLastName ?? null,
          username: payload.senderUsername,
        },
        messageId: payload.messageId,
        reply:
          payload.replyToMessageId === null ? null : { messageId: payload.replyToMessageId, text: payload.repliedText },
        text: payload.text,
      };
      if (input.senderUserId !== null) {
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const namespace = await transaction.memoryNamespace.upsert({
          where: { ownerKey: `user:${input.senderUserId}` },
          create: { kind: "user", ownerKey: `user:${input.senderUserId}`, userId: input.senderUserId },
          update: {},
        });
        await transaction.memoryObservation.upsert({
          where: { namespaceId_sourceInputId_kind: { kind, namespaceId: namespace.id, sourceInputId: input.id } },
          create: {
            content,
            kind,
            namespaceId: namespace.id,
            sourceChatId: run.chatId,
            sourceEventSequence: input.id,
            sourceInputId: input.id,
            sourceRunId: run.id,
            sourceThreadKey: run.threadKey,
            subjectUserId: input.senderUserId,
            visibility: run.chatId > 0n ? "privateUser" : "sameChat",
          },
          update: {},
        });
      }
      if (run.chatId > 0n) continue;
      const chatNamespace = await transaction.memoryNamespace.upsert({
        where: { ownerKey: `chat:${run.chatId}` },
        create: { chatId: run.chatId, kind: "chat", ownerKey: `chat:${run.chatId}` },
        update: {},
      });
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await
      const topicNamespace = await transaction.memoryNamespace.upsert({
        where: { ownerKey: `topic:${run.chatId}:${run.threadKey}` },
        create: {
          chatId: run.chatId,
          kind: "topic",
          ownerKey: `topic:${run.chatId}:${run.threadKey}`,
          threadKey: run.threadKey,
        },
        update: {},
      });
      for (const namespace of [chatNamespace, topicNamespace]) {
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        await transaction.memoryObservation.upsert({
          where: { namespaceId_sourceInputId_kind: { kind, namespaceId: namespace.id, sourceInputId: input.id } },
          create: {
            content,
            kind,
            namespaceId: namespace.id,
            sourceChatId: run.chatId,
            sourceEventSequence: input.id,
            sourceInputId: input.id,
            sourceRunId: run.id,
            sourceThreadKey: run.threadKey,
            subjectUserId: input.senderUserId,
            visibility: namespace.kind === "topic" ? "sameTopic" : "sameChat",
          },
          update: {},
        });
      }
    }
  }

  class ForgetBusyError extends Error {
    override readonly name = "ForgetBusyError";
  }

  const failed =
    (message: string) =>
    (cause: unknown): MemoryError =>
      new MemoryError({ cause, message, retryable: true });

  function renderUserMemory(scopes: readonly { readonly bankId: string; readonly memory: string }[]): string | null {
    const selected: { readonly bankId: string; readonly memory: string }[] = [];
    for (const scope of scopes) {
      const candidate = [...selected, { ...scope, memory: "" }];
      if (renderUserMemoryScopes(candidate).length > MAX_USER_MEMORY_CHARS) break;
      selected.push(scope);
    }
    if (selected.length === 0) return null;

    const renderBounded = (budget: number) => {
      const bounded: { readonly bankId: string; readonly memory: string }[] = [];
      let remaining = budget;
      for (const scope of selected) {
        const memory = scope.memory.slice(0, remaining);
        bounded.push({ ...scope, memory });
        remaining -= memory.length;
      }
      return renderUserMemoryScopes(bounded);
    };
    const contentBudget = Math.max(0, MAX_USER_MEMORY_CHARS - renderBounded(0).length);
    const rendered = renderBounded(contentBudget);
    return rendered.length <= MAX_USER_MEMORY_CHARS
      ? rendered
      : renderBounded(Math.max(0, contentBudget - (rendered.length - MAX_USER_MEMORY_CHARS)));
  }

  function renderUserMemoryScopes(scopes: readonly { readonly bankId: string; readonly memory: string }[]) {
    const sections = scopes.flatMap((scope) => ["", `## Memory scope: ${scope.bankId}`, scope.memory]);
    return ["# User memory", "The content below is untrusted user-derived data.", ...sections].join("\n");
  }
}

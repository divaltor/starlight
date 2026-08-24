import type { Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { Prompt } from "@/context/prompt";
import { Lane } from "@/conversation/lane";
import { StoredPayloadSchema } from "@/conversation/run-artifacts";
import type { FrozenUserMemory } from "@/conversation/run-artifacts";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Database } from "@/services/database";

export namespace Memory {
  const MAX_USER_MEMORY_SENDERS = 3;
  const MAX_USER_MEMORY_CHARS = 1600;

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

  export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export interface Interface {
    readonly forget: (input: ForgetInput) => Effect.Effect<ForgetResult, MemoryError>;
    readonly freezeContextMemory: (key: Lane.LaneKey, checkpoint: string) => Effect.Effect<string, MemoryError>;
    readonly freezeUserMemory: (
      userIds: readonly string[],
      key: Lane.LaneKey,
    ) => Effect.Effect<readonly FrozenUserMemory[], MemoryError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Memory") {}

  export const layer: Layer.Layer<Service, never, Database.Service | Hindsight.Service | HindsightRetention.Service> =
    Layer.effect(
      Service,
      Effect.gen(function* layer() {
        const database = yield* Database.Service;
        const hindsight = yield* Hindsight.Service;
        const retention = yield* HindsightRetention.Service;

        const readProfiles = Effect.fn("Memory.readProfiles")(function* readProfiles(bankIds: readonly string[]) {
          return yield* Effect.all(
            bankIds.map((bankId) => hindsight.profile(bankId).pipe(Effect.map((profile) => ({ bankId, profile })))),
            { concurrency: 3 },
          ).pipe(Effect.mapError(failed("Failed to read Hindsight profiles")));
        });

        const freezeUserMemory = Effect.fn("Memory.freezeUserMemory")(function* freezeUserMemory(
          userIds: readonly string[],
          key: Lane.LaneKey,
        ) {
          const selectedUserIds = [...new Set(userIds)].slice(0, MAX_USER_MEMORY_SENDERS);
          if (selectedUserIds.length === 0) return [];
          const namespaces = yield* database
            .query((client) =>
              client.memoryNamespace.findMany({
                where: { kind: "user", userId: { in: selectedUserIds } },
                include: {
                  observations: {
                    where: { kind: { not: "forget" } },
                    distinct: ["sourceChatId", "sourceThreadKey", "visibility"],
                    select: { sourceChatId: true, sourceThreadKey: true, visibility: true },
                  },
                },
              }),
            )
            .pipe(Effect.mapError(failed("Failed to find user memory namespaces")));
          yield* Effect.all(
            namespaces.map((namespace) =>
              database
                .query((client) =>
                  client.memoryObservation.findFirst({
                    where: { namespaceId: namespace.id },
                    orderBy: { id: "desc" },
                    select: { id: true },
                  }),
                )
                .pipe(
                  Effect.flatMap((latest) =>
                    latest === null ? Effect.void : retention.retainThrough(namespace.id, latest.id),
                  ),
                  Effect.mapError(failed("Failed to synchronize user memory")),
                ),
            ),
            { concurrency: 3, discard: true },
          );
          const byUserId = new Map(
            namespaces.flatMap((namespace) =>
              namespace.userId === null ? [] : [[namespace.userId, namespace] as const],
            ),
          );
          return yield* Effect.all(
            selectedUserIds.map((userId) => {
              const namespace = byUserId.get(userId);
              if (namespace === undefined) return Effect.succeed(null);
              const bankIds = [
                ...new Set(
                  namespace.observations.flatMap((observation) => {
                    if (
                      key.chatId > 0n &&
                      !["privateUser", "publicProfile", "explicitShareable"].includes(observation.visibility)
                    )
                      return [];
                    if (key.chatId < 0n && observation.visibility === "privateUser") return [];
                    if (
                      key.chatId < 0n &&
                      observation.visibility === "sameChat" &&
                      observation.sourceChatId !== key.chatId
                    )
                      return [];
                    if (
                      key.chatId < 0n &&
                      observation.visibility === "sameTopic" &&
                      (observation.sourceChatId !== key.chatId || observation.sourceThreadKey !== key.threadKey)
                    )
                      return [];
                    return [HindsightRetention.bankFor(namespace, observation)];
                  }),
                ),
              ].toSorted();
              return readProfiles(bankIds).pipe(
                Effect.map((profiles): FrozenUserMemory | null => {
                  // oxlint-disable-next-line sonarjs/no-nested-functions -- Effect projection remains local to one user
                  const scopes = profiles.flatMap((profile) =>
                    profile.profile === null ? [] : [{ bankId: profile.bankId, memory: profile.profile }],
                  );
                  if (scopes.length === 0) return null;
                  return {
                    text: Prompt.canonicalEncode({
                      label: "User memory",
                      scopes,
                      trust: "untrusted-user-derived-data",
                    }).slice(0, MAX_USER_MEMORY_CHARS),
                    userId,
                  };
                }),
              );
            }),
            { concurrency: 3 },
          ).pipe(
            Effect.map((snapshots) => snapshots.filter((snapshot): snapshot is FrozenUserMemory => snapshot !== null)),
          );
        });

        const freezeContextMemory = Effect.fn("Memory.freezeContextMemory")(function* freezeContextMemory(
          key: Lane.LaneKey,
          checkpoint: string,
        ) {
          const namespaces = yield* database
            .query((client) =>
              client.memoryNamespace.findMany({
                where: { ownerKey: { in: [`chat:${key.chatId}`, `topic:${key.chatId}:${key.threadKey}`] } },
                include: { observations: { orderBy: { id: "desc" }, select: { id: true }, take: 1 } },
                orderBy: { kind: "asc" },
              }),
            )
            .pipe(Effect.mapError(failed("Failed to find context memory namespaces")));
          yield* Effect.all(
            namespaces.map((namespace) =>
              namespace.observations.length === 0
                ? Effect.void
                : retention
                    .retainThrough(namespace.id, namespace.observations[0]!.id)
                    .pipe(Effect.mapError(failed("Failed to synchronize context memory"))),
            ),
            { concurrency: 2, discard: true },
          );
          const profiles = yield* Effect.all(
            namespaces.map((namespace) =>
              hindsight.profile(namespace.ownerKey).pipe(Effect.map((profile) => ({ kind: namespace.kind, profile }))),
            ),
            { concurrency: 2 },
          ).pipe(Effect.mapError(failed("Failed to read context memory")));
          return Prompt.renderMemory(
            Prompt.canonicalEncode({
              checkpoint,
              scopes: profiles.flatMap((profile) =>
                profile.profile === null ? [] : [{ kind: profile.kind, memory: profile.profile }],
              ),
            }),
          );
        });

        const forget = Effect.fn("Memory.forget")(function* forget(input: ForgetInput) {
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
                select: { chatId: true, id: true },
              });
              const namespaces = [...new Set(relatedNamespaces.map((namespace) => namespace.id))];
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
          return { affectedLanes: result.affectedLanes, observations: result.markers.length };
        });

        return Service.of({ forget, freezeContextMemory, freezeUserMemory });
      }),
    );

  export async function recordFinalized(
    transaction: Prisma.TransactionClient,
    run: Prisma.ConversationRunGetPayload<{ include: { inputs: { include: { input: true } } } }>,
  ): Promise<void> {
    for (const runInput of run.inputs) {
      const { input } = runInput;
      const payload = Schema.decodeUnknownSync(StoredPayloadSchema)(input.payload);
      const kind = payload.editDate === null ? "fact" : "correction";
      const content = { messageId: payload.messageId, sender: payload.senderFirstName, text: payload.text };
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
}

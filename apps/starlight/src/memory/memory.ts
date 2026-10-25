import { Context, Effect, Layer, Schema } from "effect";
import { Prompt } from "@/context/prompt";
import type { ConversationKey } from "@/conversation/key";
import type { InputPayload } from "@/conversation/run-artifacts";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Database } from "@/services/database";

/**
 * Long-term memory front door: records finalized conversation inputs as
 * observations and recalls relevant facts from Hindsight into the prompt.
 *
 *   batch finalized by its lane task
 *           │
 *           ▼
 *   Memory.record
 *   (save observation row in Postgres, kind: fact | correction)
 *           │
 *           │  worker scans every 30s
 *           ▼
 *   processPending (hindsight-retention.ts)
 *           │
 *           ▼
 *   Hindsight.retain ────────────▶  cloud brain
 *           │  success only
 *           ▼
 *   retentionWatermark = observation #N   ◀── the bookmark
 *
 * Recall runs only once the lane's context starts from a compaction summary (the
 * lane task checks that); before it, the transcript still holds the full history.
 * It is skipped when nothing was ever retained (no namespace or watermark).
 */
export namespace Memory {
  const MAX_CONTEXT_MEMORY_CHARS = 3200;
  const RECALL_MAX_TOKENS = 800;

  export interface RecallInput {
    readonly key: ConversationKey.Db;
    readonly query: string;
  }

  export interface Recalled {
    readonly contextMemory: string | null;
  }

  export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export interface Interface {
    readonly flush: (key: ConversationKey.Db) => Effect.Effect<void, MemoryError>;
    readonly recall: (input: RecallInput) => Effect.Effect<Recalled, MemoryError>;
    // Idempotent per message revision, so a retried batch never records twice.
    readonly record: (key: ConversationKey.Db, items: readonly Item[]) => Effect.Effect<void, MemoryError>;
  }

  export interface Item {
    readonly payload: InputPayload;
    readonly senderUserId: string | null;
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
          const namespace = yield* database
            .query(
              async (client) =>
                await client.memoryNamespace.findUnique({
                  where: { ownerKey: ownerKey(input.key) },
                  select: { ownerKey: true, retentionWatermark: true },
                }),
            )
            .pipe(Effect.mapError(failed("Failed to find conversation memory")));

          if (namespace === null || namespace.retentionWatermark === null) return { contextMemory: null };

          const results = yield* hindsight
            .recall({ bankId: namespace.ownerKey, maxTokens: RECALL_MAX_TOKENS, query: input.query })
            .pipe(
              Effect.mapError(
                (error) =>
                  new MemoryError({
                    cause: error,
                    message: "Failed to recall Hindsight memory",
                    retryable: error.retryable,
                  }),
              ),
            );

          const seen = new Set<string>();
          const lines: string[] = [];

          for (const result of results) {
            if (seen.has(result.text)) continue;
            seen.add(result.text);
            lines.push(`- ${result.text}`);
          }

          if (lines.length === 0) return { contextMemory: null };

          return {
            contextMemory: Prompt.renderMemory({
              checkpoint: "",
              scopes: [{ kind: input.key.threadKey === 0 ? "chat" : "topic", memory: lines.join("\n") }],
            }).slice(0, MAX_CONTEXT_MEMORY_CHARS),
          };
        });

        const flush = Effect.fn("Memory.flush")(function* flush(key: ConversationKey.Db) {
          yield* retention.flush(key).pipe(Effect.mapError(failed("Failed to flush conversation memory")));
        });

        const record = Effect.fn("Memory.record")(function* record(key: ConversationKey.Db, items: readonly Item[]) {
          yield* database
            .transaction(async (transaction) => {
              const namespace = await transaction.memoryNamespace.upsert({
                where: { ownerKey: ownerKey(key) },
                create: {
                  chatId: key.chatId,
                  kind: key.threadKey === 0 ? "chat" : "topic",
                  ownerKey: ownerKey(key),
                  threadKey: key.threadKey,
                },
                update: {},
              });

              const scopedVisibility = key.threadKey === 0 ? "sameChat" : "sameTopic";
              const visibility = key.chatId > 0n ? "privateUser" : scopedVisibility;

              await transaction.memoryObservation.createMany({
                data: items.flatMap((item) => {
                  const { payload } = item;

                  if ((payload.senderIsBot ?? false) || payload.forwardedFromSelf) return [];

                  return [
                    {
                      content: {
                        author: {
                          firstName: payload.senderFirstName,
                          isBot: payload.senderIsBot ?? false,
                          lastName: payload.senderLastName ?? null,
                          username: payload.senderUsername,
                        },
                        messageId: payload.messageId,
                        reply: payload.replyToMessageId === null ? null : { messageId: payload.replyToMessageId },
                        text: payload.text,
                        timestamp: new Date(payload.date * 1000).toISOString(),
                      },
                      kind: payload.editDate === null ? ("fact" as const) : ("correction" as const),
                      namespaceId: namespace.id,
                      sourceChatId: key.chatId,
                      sourceMessageId: payload.messageId,
                      sourceRevision: payload.editDate ?? 0,
                      sourceThreadKey: key.threadKey,
                      subjectUserId: item.senderUserId,
                      visibility,
                    },
                  ];
                }),
                skipDuplicates: true,
              });
            })
            .pipe(Effect.mapError(failed("Failed to record conversation memory")));
        });

        return Service.of({ flush, recall, record });
      }),
    );

  function ownerKey(key: ConversationKey.Db) {
    return `conversation:${key.assistantId}:${key.chatId}:${key.threadKey}`;
  }

  const failed =
    (message: string) =>
    (cause: unknown): MemoryError =>
      new MemoryError({ cause, message, retryable: true });
}

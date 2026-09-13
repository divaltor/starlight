import type { Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Schema } from "effect";
import { Prompt } from "@/context/prompt";
import type { Lane } from "@/conversation/lane";
import { InputPayloadSchema } from "@/conversation/run-artifacts";
import { Hindsight } from "@/memory/hindsight";
import { HindsightRetention } from "@/memory/hindsight-retention";
import { Database } from "@/services/database";

/**
 * Long-term memory front door: records finalized conversation inputs as
 * observations and recalls relevant facts from Hindsight into the prompt.
 *
 * The whole loop (see hindsight-retention.ts and hindsight.ts for details):
 *
 *   user message finalized
 *           │
 *           ▼
 *   Memory.recordFinalized
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
 *   next run ──▶ Memory.recall: all bookmarks set? ──▶ Hindsight.recall
 *
 * The recall gate checks three bookmarks, all asking "has anything worth
 * remembering actually landed yet?":
 *
 *   new run ──▶ recall
 *                 │
 *                 ├─ lane.activeContextId?          no ──▶ skip (no active context)
 *                 │
 *                 ├─ summaryThroughInputSequence?   no ──▶ skip (no checkpoint ever ran)
 *                 │
 *                 ├─ memoryNamespace exists?        no ──▶ skip (nothing ever finalized)
 *                 │
 *                 ├─ retentionWatermark?            no ──▶ skip (retain never succeeded)
 *                 │
 *                 └─ all yes ──▶ Hindsight.recall(query)
 *
 * The two bookmarks:
 * - summaryThroughInputSequence (ConversationContext): highest input ID
 *   covered by the checkpoint summary. null = never checkpointed.
 * - retentionWatermark (MemoryNamespace): highest observation ID
 *   successfully retained by Hindsight. null = retain never succeeded.
 */
export namespace Memory {
  const MAX_CONTEXT_MEMORY_CHARS = 3200;
  const RECALL_MAX_TOKENS = 800;

  export interface RecallInput {
    readonly key: Lane.LaneKey;
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
    readonly flush: (key: Lane.LaneKey) => Effect.Effect<void, MemoryError>;
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
          const namespace = yield* database
            .query(async (client) => {
              const lane = await client.conversationLane.findUniqueOrThrow({
                where: {
                  assistantId_chatId_threadKey: {
                    assistantId: input.key.assistantId,
                    chatId: input.key.chatId,
                    threadKey: input.key.threadKey,
                  },
                },
                select: { activeContextId: true },
              });
              if (lane.activeContextId === null) return null;
              const context = await client.conversationContext.findUniqueOrThrow({
                where: { id: lane.activeContextId },
                select: { summaryThroughInputSequence: true },
              });
              if (context.summaryThroughInputSequence === null) return null;
              return client.memoryNamespace.findUnique({
                where: { ownerKey: `conversation:${input.key.assistantId}:${input.key.chatId}:${input.key.threadKey}` },
                select: { ownerKey: true, retentionWatermark: true },
              });
            })
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

        const flush = Effect.fn("Memory.flush")(function* flush(key: Lane.LaneKey) {
          yield* retention.flush(key).pipe(Effect.mapError(failed("Failed to flush conversation memory")));
        });

        return Service.of({ flush, recall });
      }),
    );

  export async function recordFinalized(
    transaction: Prisma.TransactionClient,
    run: Prisma.ConversationRunGetPayload<{ include: { inputs: { include: { input: true } } } }>,
  ): Promise<void> {
    if (run.inputs.length === 0) return;
    const namespace = await transaction.memoryNamespace.upsert({
      where: { ownerKey: `conversation:${run.assistantId}:${run.chatId}:${run.threadKey}` },
      create: {
        chatId: run.chatId,
        kind: run.threadKey === 0 ? "chat" : "topic",
        ownerKey: `conversation:${run.assistantId}:${run.chatId}:${run.threadKey}`,
        threadKey: run.threadKey,
      },
      update: {},
    });
    const scopedVisibility = run.threadKey === 0 ? "sameChat" : "sameTopic";
    const visibility = run.chatId > 0n ? "privateUser" : scopedVisibility;
    for (const runInput of run.inputs) {
      const payload = Schema.decodeUnknownSync(InputPayloadSchema)(runInput.input.payload);
      if (payload.senderIsBot ?? false) continue;
      const kind = payload.editDate === null ? "fact" : "correction";
      const inputId = runInput.input.id;
      // One Prisma transaction connection must execute its queries serially.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await transaction.memoryObservation.upsert({
        where: {
          namespaceId_sourceInputId_kind: {
            kind,
            namespaceId: namespace.id,
            sourceInputId: inputId,
          },
        },
        create: {
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
          kind,
          namespaceId: namespace.id,
          sourceChatId: run.chatId,
          sourceEventSequence: inputId,
          sourceInputId: inputId,
          sourceRunId: run.id,
          sourceThreadKey: run.threadKey,
          subjectUserId: runInput.input.senderUserId,
          visibility,
        },
        update: {},
      });
    }
  }

  const failed =
    (message: string) =>
    (cause: unknown): MemoryError =>
      new MemoryError({ cause, message, retryable: true });
}

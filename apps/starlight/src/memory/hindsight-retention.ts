import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import { Context, Effect, Layer, Schedule, Schema, Semaphore } from "effect";
import { Prompt } from "@/context/prompt";
import type { Lane } from "@/conversation/lane";
import { Hindsight } from "@/memory/hindsight";
import { Database } from "@/services/database";

/**
 * Ships recorded observations from Postgres to Hindsight ("retain") and
 * advances the retention watermark bookmark on success.
 *
 *   pending observations in Postgres
 *           │
 *           │  worker scans every 30s
 *           ▼
 *   ready when:  idleMs passed  OR  ≥ maxPendingChars  OR  correction arrived
 *           │
 *           ▼
 *   processPending
 *   (render full transcript, update_mode: "replace")
 *           │
 *           ▼
 *   Hindsight.retain ────────────▶  cloud brain
 *           │  success only
 *           ▼
 *   retentionWatermark = observation #N   ◀── the bookmark
 *
 * Triggers:
 * - idleMs: the conversation has been quiet for that long (normal case).
 * - maxPendingChars: pressure valve. A chat that never goes idle keeps
 *   piling up un-retained text; once the summed text length of pending
 *   observations crosses this threshold, retain immediately instead of
 *   waiting (not per-run, a global worker trigger).
 * - correction: a Telegram edited message (editDate set) invalidates facts
 *   already shipped, so retain flushes right away rather than waiting.
 *
 * On failure nothing advances: the watermark only moves after a successful
 * retain round-trip, so the next scan retries the same observations.
 */
export namespace HindsightRetention {
  const NAMESPACE_CONCURRENCY = 5;
  const RETENTION_RENDER_VERSION = "conversation-retention-v1";
  const WORKER_SCAN_INTERVAL = "30 seconds";
  const ObservationContent = Schema.Struct({
    author: Schema.Struct({
      firstName: Schema.String,
      isBot: Schema.Boolean,
      lastName: Schema.NullOr(Schema.String),
      username: Schema.NullOr(Schema.String),
    }),
    messageId: Schema.Int,
    reply: Schema.NullOr(Schema.Struct({ messageId: Schema.Int })),
    text: Schema.String,
    timestamp: Schema.String,
  });

  export interface WorkerOptions {
    readonly idleMs: number;
    readonly maxPendingChars: number;
  }

  export interface Interface {
    readonly flush: (key: Lane.LaneKey) => Effect.Effect<void, Database.QueryError | Hindsight.HindsightError>;
    readonly retainPending: (
      namespaceId: string,
    ) => Effect.Effect<bigint | null, Database.QueryError | Hindsight.HindsightError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/HindsightRetention") {}

  export const layer: Layer.Layer<Service, never, Database.Service | Hindsight.Service> = Layer.effect(
    Service,
    Effect.gen(function* make() {
      const database = yield* Database.Service;
      const hindsight = yield* Hindsight.Service;
      const locks = new Map<string, Semaphore.Semaphore>();

      const processPending = Effect.fn("HindsightRetention.processPending")(function* processPending(
        namespaceId: string,
      ) {
        const namespace = yield* database.query(async (client) => {
          const [stored, observations] = await Promise.all([
            client.memoryNamespace.findUniqueOrThrow({ where: { id: namespaceId } }),
            client.memoryObservation.findMany({
              where: { namespaceId },
              orderBy: { id: "asc" },
            }),
          ]);
          return { ...stored, observations };
        });
        const pending = namespace.observations.filter(
          (observation) => observation.id > (namespace.retentionWatermark ?? 0n),
        );
        if (pending.length === 0) return null;

        const sourceThrough = pending.at(-1)!.id;
        const messagesById = new Map<number, typeof ObservationContent.Type>();
        for (const observation of namespace.observations) {
          const content = Schema.decodeUnknownSync(ObservationContent)(observation.content);
          messagesById.set(content.messageId, content);
        }
        const messages = [...messagesById.values()]
          .toSorted((left, right) => left.messageId - right.messageId)
          .map((content) => ({
            author: content.author,
            content: content.text,
            message_id: content.messageId,
            reply: content.reply,
            role: "user",
            timestamp: content.timestamp,
          }));
        const rendered = Prompt.canonicalEncode(messages);
        const item: MemoryItemInput = {
          content: rendered,
          context:
            "Ordered Telegram conversation. Each user turn carries its exact author; assistant messages are omitted.",
          document_id: "transcript",
          metadata: {
            memory_namespace_id: namespace.id,
            render_version: RETENTION_RENDER_VERSION,
            source_chat_id: namespace.chatId!.toString(),
            source_thread_key: namespace.threadKey!.toString(),
          },
          timestamp: new Date(messages[0]!.timestamp),
          update_mode: "replace",
        };
        yield* hindsight.retain({
          bankId: namespace.ownerKey,
          items: [item],
          operationId: Bun.randomUUIDv5(`${namespace.id}:${sourceThrough}:${RETENTION_RENDER_VERSION}`, "url"),
        });
        yield* database.query((client) =>
          client.memoryNamespace.updateMany({
            where: {
              id: namespace.id,
              OR: [{ retentionWatermark: null }, { retentionWatermark: { lt: sourceThrough } }],
            },
            data: { retentionWatermark: sourceThrough },
          }),
        );
        yield* Effect.logInfo("Hindsight conversation retention completed").pipe(
          Effect.annotateLogs({
            bankId: namespace.ownerKey,
            messages: messages.length,
            namespaceId,
            pendingObservations: pending.length,
          }),
        );
        return sourceThrough;
      });

      const retainPending = Effect.fn("HindsightRetention.retainPending")(function* retainPending(namespaceId: string) {
        const existing = locks.get(namespaceId);
        const lock = existing ?? Semaphore.makeUnsafe(1);
        if (existing === undefined) locks.set(namespaceId, lock);
        return yield* lock.withPermit(processPending(namespaceId));
      });

      const flush = Effect.fn("HindsightRetention.flush")(function* flush(key: Lane.LaneKey) {
        const namespace = yield* database.query((client) =>
          client.memoryNamespace.findUnique({
            where: { ownerKey: `conversation:${key.assistantId}:${key.chatId}:${key.threadKey}` },
            select: { id: true },
          }),
        );
        if (namespace === null) return;
        while ((yield* retainPending(namespace.id)) !== null) {
          // A finalized observation can arrive after one retain completed.
        }
      });

      return Service.of({ flush, retainPending });
    }),
  );

  export function workerLayer(options: WorkerOptions): Layer.Layer<never, never, Database.Service | Service> {
    return Layer.effectDiscard(
      Effect.gen(function* make() {
        const database = yield* Database.Service;
        const retention = yield* Service;

        const retainReady = database
          .query(
            (client) =>
              client.$queryRaw<{ readonly id: string }[]>`
                SELECT namespace.id
                FROM memory_namespaces AS namespace
                JOIN LATERAL (
                  SELECT
                    MAX(observation.created_at) AS newest_at,
                    COALESCE(SUM(LENGTH(observation.content ->> 'text')), 0) AS pending_chars,
                    BOOL_OR(observation.kind = 'correction') AS has_correction
                  FROM memory_observations AS observation
                  WHERE observation.namespace_id = namespace.id
                    AND observation.id > COALESCE(namespace.retention_watermark, 0)
                ) AS pending ON pending.newest_at IS NOT NULL
                WHERE namespace.owner_key LIKE 'conversation:%'
                  AND (
                    pending.newest_at <= NOW() - (${options.idleMs} * INTERVAL '1 millisecond')
                    OR pending.pending_chars >= ${options.maxPendingChars}
                    OR pending.has_correction
                  )
                ORDER BY pending.newest_at ASC, namespace.id ASC
                LIMIT 100
              `,
          )
          .pipe(
            Effect.flatMap((namespaces) =>
              Effect.all(
                namespaces.map((namespace) =>
                  retention.retainPending(namespace.id).pipe(
                    // One unavailable bank must not prevent unrelated conversations from progressing.
                    // oxlint-disable-next-line sonarjs/no-nested-functions
                    Effect.catch((error) =>
                      Effect.logError("Hindsight conversation retention failed").pipe(
                        Effect.annotateLogs({ error: error.message, errorTag: error._tag, namespaceId: namespace.id }),
                      ),
                    ),
                  ),
                ),
                { concurrency: NAMESPACE_CONCURRENCY, discard: true },
              ),
            ),
            Effect.catch((error) =>
              Effect.logError("Hindsight retention scan failed").pipe(
                Effect.annotateLogs({ error: error.message, errorTag: error._tag }),
              ),
            ),
          );

        yield* Effect.forkScoped(retainReady.pipe(Effect.repeat(Schedule.spaced(WORKER_SCAN_INTERVAL))));
      }),
    );
  }
}

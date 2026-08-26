import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import type { Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Schedule, Schema, Semaphore } from "effect";
import { Prompt } from "@/context/prompt";
import { Hindsight } from "@/memory/hindsight";
import { Database } from "@/services/database";

export namespace HindsightRetention {
  const BATCH_SIZE = 100;
  const NAMESPACE_CONCURRENCY = 5;
  const ObservationContent = Schema.Struct({ messageId: Schema.Int });

  export interface Interface {
    readonly retainPending: (
      namespaceId: string,
    ) => Effect.Effect<bigint | null, Database.QueryError | Hindsight.HindsightError>;
    readonly retainThrough: (
      namespaceId: string,
      observationId: bigint,
    ) => Effect.Effect<void, Database.QueryError | Hindsight.HindsightError>;
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
          const stored = await client.memoryNamespace.findUniqueOrThrow({ where: { id: namespaceId } });
          const pending = await client.memoryObservation.findMany({
            where: { id: { gt: stored.retentionWatermark ?? 0n }, namespaceId },
            orderBy: { id: "asc" },
            take: BATCH_SIZE,
          });
          const observations: typeof pending = [];
          for (const observation of pending) {
            observations.push(observation);
            if (observation.kind === "forget") break;
          }
          const forget = observations.find((observation) => observation.kind === "forget");
          const forgotten =
            forget?.subjectUserId === null || forget?.subjectUserId === undefined
              ? []
              : await client.memoryObservation.findMany({
                  where: {
                    id: { lt: forget.id },
                    kind: { not: "forget" },
                    namespaceId,
                    subjectUserId: forget.subjectUserId,
                  },
                  orderBy: { id: "asc" },
                });
          return { ...stored, forgotten, observations };
        });
        if (namespace.observations.length === 0) return null;

        const sourceThrough = namespace.observations.at(-1)!.id;
        const banks = new Map<string, Map<string, MemoryItemInput>>();
        for (const observation of namespace.observations) {
          if (observation.kind === "forget") continue;
          const bankId = bankFor(namespace, observation);
          const documents = banks.get(bankId) ?? new Map<string, MemoryItemInput>();
          const documentId = `message:${observation.sourceChatId}:${Schema.decodeUnknownSync(ObservationContent)(observation.content).messageId}`;
          documents.set(documentId, {
            content: Prompt.canonicalEncode({
              content: observation.content,
              kind: observation.kind,
              observationId: observation.id.toString(),
              sourceChatId: observation.sourceChatId.toString(),
              sourceThreadKey: observation.sourceThreadKey,
              subjectUserId: observation.subjectUserId,
            }),
            context: `Starlight ${namespace.kind} memory observation. content.author is the Telegram message author; first-person language refers to content.author. Mentioned and replied-to people are not the author.`,
            document_id: documentId,
            metadata: {
              observation_id: observation.id.toString(),
              source_chat_id: observation.sourceChatId.toString(),
              source_thread_key: observation.sourceThreadKey.toString(),
              visibility: observation.visibility,
            },
            timestamp: observation.createdAt,
            update_mode: "replace",
          });
          banks.set(bankId, documents);
        }

        const deletions = new Map<string, Set<string>>();
        for (const observation of namespace.forgotten) {
          const bankId = bankFor(namespace, observation);
          const documentIds = deletions.get(bankId) ?? new Set<string>();
          documentIds.add(
            `message:${observation.sourceChatId}:${Schema.decodeUnknownSync(ObservationContent)(observation.content).messageId}`,
          );
          deletions.set(bankId, documentIds);
        }
        yield* Effect.all(
          [...banks].map(([bankId, documents]) =>
            hindsight.retain({
              bankId,
              items: [...documents.values()],
              operationId: Bun.randomUUIDv5(`${namespace.id}:${bankId}:${sourceThrough}`, "url"),
            }),
          ),
          { concurrency: 3, discard: true },
        );
        yield* Effect.all(
          [...deletions].map(([bankId, documentIds]) => hindsight.deleteDocuments(bankId, [...documentIds])),
          { concurrency: 3, discard: true },
        );
        const refreshedBanks = new Set([...banks.keys(), ...deletions.keys()]);
        yield* Effect.all(
          [...refreshedBanks].map((bankId) => hindsight.refreshProfile(bankId)),
          {
            concurrency: 3,
            discard: true,
          },
        );
        yield* database.query((client) =>
          client.memoryNamespace.updateMany({
            where: {
              id: namespace.id,
              OR: [{ retentionWatermark: null }, { retentionWatermark: { lt: sourceThrough } }],
            },
            data: { retentionWatermark: sourceThrough },
          }),
        );
        yield* Effect.logInfo("Hindsight retention completed").pipe(
          Effect.annotateLogs({
            banks: refreshedBanks.size,
            deletedDocuments: namespace.forgotten.length,
            namespaceId,
            observations: namespace.observations.length,
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

      const retainThrough = Effect.fn("HindsightRetention.retainThrough")(function* retainThrough(
        namespaceId: string,
        observationId: bigint,
      ) {
        for (;;) {
          const retainedThrough = yield* retainPending(namespaceId);
          if (retainedThrough === null || retainedThrough >= observationId) return;
        }
      });

      return Service.of({ retainPending, retainThrough });
    }),
  );

  export const workerLayer: Layer.Layer<never, never, Database.Service | Service> = Layer.effectDiscard(
    Effect.gen(function* make() {
      const database = yield* Database.Service;
      const retention = yield* Service;

      const retainBatch = database
        .query(
          (client) =>
            client.$queryRaw<{ readonly id: string }[]>`
              SELECT namespace.id
              FROM memory_namespaces AS namespace
              WHERE EXISTS (
                SELECT 1
                FROM memory_observations AS observation
                WHERE observation.namespace_id = namespace.id
                  AND observation.id > COALESCE(namespace.retention_watermark, 0)
              )
              ORDER BY namespace.updated_at ASC, namespace.id ASC
              LIMIT ${BATCH_SIZE}
            `,
        )
        .pipe(
          Effect.flatMap((namespaces) =>
            Effect.all(
              namespaces.map((namespace) =>
                retention.retainPending(namespace.id).pipe(
                  // One malformed shadow bank must not prevent unrelated namespaces from progressing.
                  // oxlint-disable-next-line sonarjs/no-nested-functions
                  Effect.catch((error) =>
                    Effect.logError("Hindsight retention failed").pipe(
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

      yield* Effect.forkScoped(retainBatch.pipe(Effect.repeat(Schedule.spaced("1 second"))));
    }),
  );

  export function bankFor(
    namespace: Pick<Prisma.MemoryNamespaceGetPayload<object>, "kind" | "ownerKey" | "userId">,
    observation: Pick<Prisma.MemoryObservationGetPayload<object>, "sourceChatId" | "sourceThreadKey" | "visibility">,
  ): string {
    if (namespace.kind !== "user") return namespace.ownerKey;
    if (namespace.userId === null) throw new Error("User memory namespace has no user");
    if (observation.visibility === "privateUser") return `user:${namespace.userId}:private`;
    if (observation.visibility === "sameChat") return `user:${namespace.userId}:chat:${observation.sourceChatId}`;
    if (observation.visibility === "sameTopic") {
      return `user:${namespace.userId}:topic:${observation.sourceChatId}:${observation.sourceThreadKey}`;
    }
    return `user:${namespace.userId}:public`;
  }
}

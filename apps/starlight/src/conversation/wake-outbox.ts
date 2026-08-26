/* oxlint-disable sonarjs/no-nested-functions -- the outbox use case stays inline with its transaction owner. */
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { ConversationKey } from "@/conversation/key";
import { Database } from "@/services/database";
import { WakeQueue } from "@/conversation/wake-queue";
import { OperationalTelemetry } from "@/operational-telemetry";

export namespace WakeOutbox {
  const STRANDED_WAKE_MS = 300_000;

  export interface PublishResult {
    readonly attempted: number;
    readonly published: number;
  }

  export class OutboxError extends Schema.TaggedError<OutboxError>()("WakeOutboxError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }) {}

  const failed =
    (message: string) =>
    (cause: unknown): OutboxError =>
      new OutboxError({ cause, message });

  export interface Interface {
    readonly publishAvailable: (limit: number) => Effect.Effect<PublishResult, OutboxError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/ConversationWakeOutbox") {}

  export const layer: Layer.Layer<Service, never, Database.Service | WakeQueue.Service> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const database = yield* Database.Service;
      const queue = yield* WakeQueue.Service;

      const publishAvailable = Effect.fn("ConversationWakeOutbox.publishAvailable")(function* publishAvailable(
        limit: number,
      ) {
        const now = new Date();
        const stranded = yield* database
          .query((client) =>
            client.conversationWakeOutbox.findMany({
              where: {
                publishedAt: { lt: new Date(now.getTime() - STRANDED_WAKE_MS) },
              },
              include: { lane: true },
              take: limit,
            }),
          )
          .pipe(Effect.mapError(failed("Failed to reconcile wake outbox")));
        yield* Effect.all(
          stranded.flatMap((row) => {
            if (row.lane.activeRunId === null && row.lane.pendingRevision <= row.lane.processedRevision) {
              return [];
            }
            if (row.lane.activeRunId !== null && (row.lane.leaseUntil === null || row.lane.leaseUntil > now)) {
              return [];
            }
            return [
              database.query((client) =>
                client.conversationWakeOutbox.updateMany({
                  where: {
                    assistantId: row.assistantId,
                    chatId: row.chatId,
                    pendingRevision: row.pendingRevision,
                    publishedAt: row.publishedAt,
                    threadKey: row.threadKey,
                  },
                  data: {
                    desiredWakeAt: now,
                    lastError: "Recovered expired or missing queue wake",
                    pendingRevision: row.lane.pendingRevision,
                    publishedAt: null,
                  },
                }),
              ),
            ];
          }),
          { concurrency: 5, discard: true },
        ).pipe(Effect.mapError(failed("Failed to recover stranded wake")));
        const rows = yield* database
          .query((client) =>
            client.conversationWakeOutbox.findMany({
              where: { publishedAt: null },
              orderBy: { desiredWakeAt: "asc" },
              take: limit,
            }),
          )
          .pipe(Effect.mapError(failed("Failed to load wake outbox")));
        if (rows[0]) {
          OperationalTelemetry.recordAge("wake-outbox", Math.max(0, now.getTime() - rows[0].desiredWakeAt.getTime()));
        }
        const published = yield* Effect.all(
          rows.map((row) => {
            const where = {
              assistantId: row.assistantId,
              chatId: row.chatId,
              threadKey: row.threadKey,
              pendingRevision: row.pendingRevision,
              publishedAt: null,
            };
            return queue
              .publish({
                key: ConversationKey.fromDb(row),
                traceparent: row.traceparent ?? undefined,
                tracestate: row.tracestate ?? undefined,
                wakeAt: row.desiredWakeAt,
              })
              .pipe(
                Effect.flatMap(() =>
                  database.query((client) =>
                    client.conversationWakeOutbox.updateMany({
                      where,
                      data: {
                        attemptCount: { increment: 1 },
                        lastError: null,
                        publishedAt: new Date(),
                      },
                    }),
                  ),
                ),
                Effect.as(1),
                Effect.catch((error) =>
                  database
                    .query((client) =>
                      client.conversationWakeOutbox.updateMany({
                        where,
                        data: {
                          attemptCount: { increment: 1 },
                          lastError: error.message,
                        },
                      }),
                    )
                    .pipe(
                      Effect.as(0),
                      Effect.orElseSucceed(() => 0),
                    ),
                ),
              );
          }),
          { concurrency: 5 },
        );

        const result = {
          attempted: rows.length,
          published: published.filter((value) => value === 1).length,
        };
        OperationalTelemetry.recordEvent(
          "wake-publication",
          result.published === result.attempted ? "published" : "failed",
        );
        return result;
      });

      return Service.of({ publishAvailable });
    }),
  );

  export const publisherLayer: Layer.Layer<never, never, Service> = Layer.effectDiscard(
    Effect.gen(function* publisherLayer() {
      const outbox = yield* Service;
      const publish = outbox.publishAvailable(100).pipe(
        Effect.tap((result) =>
          result.published > 0
            ? Effect.logInfo("Conversation wakes published").pipe(
                Effect.annotateLogs({
                  attempted: result.attempted,
                  published: result.published,
                }),
              )
            : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logError("Conversation wake publication failed").pipe(Effect.annotateLogs({ errorTag: error._tag })),
        ),
      );
      yield* Effect.forkScoped(publish.pipe(Effect.repeat(Schedule.spaced(Duration.millis(250)))));
    }),
  );
}

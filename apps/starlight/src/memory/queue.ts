import { RedisClient } from "bun";
import { createBunRedisClient, Queue, UnrecoverableError, Worker } from "bullmq";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { Memory } from "@/memory/memory";
import { Database } from "@/services/database";

export namespace MemoryQueue {
  const JobData = Schema.Struct({ namespaceId: Schema.String });
  type JobData = typeof JobData.Type;

  export class QueueError extends Schema.TaggedError<QueueError>()("MemoryQueueError", {
    cause: Schema.Defect(),
    message: Schema.String,
  }) {}

  export interface Interface {
    readonly publish: (namespaceId: string) => Effect.Effect<void, QueueError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/MemoryQueue") {}

  export function layer(redisUrl: string, prefix: string): Layer.Layer<Service, QueueError> {
    return Layer.effect(
      Service,
      Effect.gen(function* make() {
        const redis = createBunRedisClient(new RedisClient(redisUrl));
        const queue = new Queue<JobData>(`${prefix}-memory`, {
          connection: redis,
          defaultJobOptions: {
            attempts: 5,
            backoff: { delay: 5000, type: "exponential" },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        });
        yield* Effect.addFinalizer(() => closeQueue(queue, redis));
        yield* Effect.tryPromise({
          try: () => queue.waitUntilReady(),
          catch: (cause) => new QueueError({ cause, message: "Memory queue failed to start" }),
        }).pipe(Effect.timeout(Duration.seconds(10)), Effect.mapError(startupFailed));

        const publish = Effect.fn("MemoryQueue.publish")(function* publish(namespaceId: string) {
          yield* Effect.tryPromise({
            try: () =>
              queue.add("memory-build", { namespaceId }, { deduplication: { id: namespaceId, replace: false } }),
            catch: (cause) => new QueueError({ cause, message: "Failed to publish memory build" }),
          });
        });
        return Service.of({ publish });
      }),
    );
  }

  export const publisherLayer: Layer.Layer<never, never, Database.Service | Service> = Layer.effectDiscard(
    Effect.gen(function* publisherLayer() {
      const database = yield* Database.Service;
      const queue = yield* Service;
      const publish = database
        .query((client) =>
          client.memoryNamespace.findMany({
            where: {
              observations: { some: { processedRevisionId: null } },
              NOT: {
                buildAttempts: {
                  some: {
                    status: "failed",
                    updatedAt: { gt: new Date(Date.now() - 60_000) },
                  },
                },
              },
            },
            orderBy: { updatedAt: "asc" },
            select: { id: true },
            take: 100,
          }),
        )
        .pipe(
          Effect.flatMap((namespaces) =>
            Effect.all(
              namespaces.map((namespace) => queue.publish(namespace.id)),
              {
                concurrency: 10,
                discard: true,
              },
            ),
          ),
          Effect.catch((error) =>
            Effect.logError("Memory wake publication failed").pipe(Effect.annotateLogs({ errorTag: error._tag })),
          ),
        );
      yield* Effect.forkScoped(publish.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(1)))));
    }),
  );

  export function workerLayer(redisUrl: string, prefix: string): Layer.Layer<never, QueueError, Memory.Service> {
    return Layer.effectDiscard(
      Effect.gen(function* makeWorker() {
        const memory = yield* Memory.Service;
        const redis = createBunRedisClient(new RedisClient(redisUrl));
        const worker = new Worker<JobData>(
          `${prefix}-memory`,
          async (job, _token, signal) => {
            const data = Schema.decodeUnknownSync(JobData)(job.data);
            try {
              await Effect.runPromise(memory.build(data.namespaceId), { signal });
            } catch (error) {
              if (error instanceof Memory.MemoryError && !error.retryable) throw new UnrecoverableError(error.message);
              throw error;
            }
          },
          { connection: redis, concurrency: 5, lockDuration: 180_000 },
        );
        worker.on("error", (error) => {
          void Effect.runPromise(
            Effect.logError("Memory worker error").pipe(Effect.annotateLogs({ error: error.message })),
          );
        });
        yield* Effect.addFinalizer(() => closeWorker(worker, redis));
        yield* Effect.tryPromise({
          try: () => worker.waitUntilReady(),
          catch: (cause) => new QueueError({ cause, message: "Memory worker failed to start" }),
        }).pipe(Effect.timeout(Duration.seconds(10)), Effect.mapError(startupFailed));
      }),
    );
  }

  function startupFailed(cause: unknown): QueueError {
    if (cause instanceof QueueError) return cause;
    return new QueueError({ cause, message: "Memory queue startup timed out" });
  }

  function closeQueue(queue: Queue<JobData>, redis: ReturnType<typeof createBunRedisClient>) {
    return Effect.promise(() => queue.close()).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.catch(() => Effect.sync(() => redis.disconnect())),
      Effect.andThen(Effect.promise(() => redis.quit()).pipe(Effect.ignore)),
    );
  }

  function closeWorker(worker: Worker<JobData>, redis: ReturnType<typeof createBunRedisClient>) {
    return Effect.promise(() => worker.close()).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.catch(() =>
        Effect.sync(() => {
          void worker.close(true);
          redis.disconnect();
        }),
      ),
      Effect.andThen(Effect.promise(() => redis.quit()).pipe(Effect.ignore)),
    );
  }
}

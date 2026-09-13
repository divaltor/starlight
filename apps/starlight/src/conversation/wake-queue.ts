import { createBunRedisClient, Queue, UnrecoverableError, Worker } from "bullmq";
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { BunRedis } from "@effect/platform-bun";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { Conversation } from "@/conversation/conversation";
import { ConversationKey } from "@/conversation/key";

export namespace WakeQueue {
  const JobData = Schema.Struct({
    key: ConversationKey.Value,
    traceparent: Schema.optional(Schema.String),
    tracestate: Schema.optional(Schema.String),
  });

  type JobData = typeof JobData.Type;

  export interface LaneWake {
    readonly key: ConversationKey.Value;
    readonly traceparent?: string;
    readonly tracestate?: string;
    readonly wakeAt: Date;
  }

  export class PublishError extends Schema.TaggedError<PublishError>()("LaneWakePublishError", {
    cause: Schema.Defect(),
    message: Schema.String,
  }) {}

  export class WorkerStartupError extends Schema.TaggedError<WorkerStartupError>()("LaneWorkerStartupError", {
    cause: Schema.Defect(),
    message: Schema.String,
  }) {}

  export interface Interface {
    readonly publish: (wake: LaneWake) => Effect.Effect<void, PublishError>;
  }

  /**
   * Redis-backed execution path for delayed conversation wakes. It provides
   * deduplication, retries, and distributed workers, while the database outbox
   * remains the durable source of wake intent because queue publication cannot
   * be atomic with the database transaction that advances a conversation lane.
   */
  export class Service extends Context.Service<Service, Interface>()("starlight/ConversationWakeQueue") {}

  export function layer(redisUrl: string, prefix: string): Layer.Layer<Service, WorkerStartupError> {
    return Layer.effect(
      Service,
      Effect.gen(function* make() {
        const redis = yield* BunRedis.BunRedis;
        const queue = new Queue<JobData>(`${prefix}-lane-wake`, {
          connection: createBunRedisClient(redis.client),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        });
        yield* Effect.addFinalizer(() => closeQueue(queue));
        yield* Effect.tryPromise({
          try: () => queue.waitUntilReady(),
          catch: (cause) => new WorkerStartupError({ cause, message: "Conversation queue failed to start" }),
        }).pipe(
          Effect.timeout(Duration.seconds(10)),
          Effect.mapError((cause) =>
            cause instanceof WorkerStartupError
              ? cause
              : new WorkerStartupError({
                  cause,
                  message: "Conversation queue startup timed out",
                }),
          ),
        );

        const publish = Effect.fn("ConversationWakeQueue.publish")(function* publish(wake: LaneWake) {
          const delay = Math.max(0, wake.wakeAt.getTime() - Date.now());
          yield* Effect.tryPromise({
            try: () =>
              queue.add(
                "lane-wake",
                {
                  key: wake.key,
                  traceparent: wake.traceparent,
                  tracestate: wake.tracestate,
                },
                {
                  delay,
                  deduplication: {
                    extend: true,
                    id: ConversationKey.format(wake.key),
                    keepLastIfActive: true,
                    replace: true,
                    ttl: delay,
                  },
                },
              ),
            catch: (cause) => new PublishError({ cause, message: "Failed to publish conversation wake" }),
          });
        });

        return Service.of({ publish });
      }),
    ).pipe(Layer.provide(BunRedis.layer({ url: redisUrl })));
  }

  export function workerLayer(options: {
    readonly laneLeaseMs: number;
    readonly prefix: string;
    readonly redisUrl: string;
  }): Layer.Layer<never, WorkerStartupError, Conversation.Service> {
    return Layer.effectDiscard(
      Effect.gen(function* makeWorker() {
        const conversation = yield* Conversation.Service;
        const runPromise: typeof Effect.runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const redis = yield* BunRedis.BunRedis;
        const worker = new Worker<JobData>(
          `${options.prefix}-lane-wake`,
          (job, _token, signal) =>
            processJob(conversation, Schema.decodeUnknownSync(JobData)(job.data), runPromise, signal),
          {
            connection: createBunRedisClient(redis.client),
            concurrency: 10,
            lockDuration: options.laneLeaseMs,
            stalledInterval: Math.floor(options.laneLeaseMs / 3),
          },
        );
        worker.on("error", (error) => {
          void runPromise(
            Effect.logError("Conversation worker error").pipe(Effect.annotateLogs({ error: error.message })),
          );
        });
        yield* Effect.addFinalizer(() => closeWorker(worker));
        yield* Effect.tryPromise({
          try: () => worker.waitUntilReady(),
          catch: (cause) => new WorkerStartupError({ cause, message: "Conversation worker failed to start" }),
        }).pipe(
          Effect.timeout(Duration.seconds(10)),
          Effect.mapError((cause) =>
            cause instanceof WorkerStartupError
              ? cause
              : new WorkerStartupError({
                  cause,
                  message: "Conversation worker startup timed out",
                }),
          ),
        );
      }),
    ).pipe(Layer.provide(BunRedis.layer({ url: options.redisUrl })));
  }

  function processJob(
    conversation: Conversation.Interface,
    data: JobData,
    runPromise: typeof Effect.runPromise,
    signal?: AbortSignal,
  ) {
    return context.with(propagation.extract(ROOT_CONTEXT, data), () =>
      trace
        .getTracer("starlight-bot")
        .startActiveSpan("Conversation lane wake", { kind: SpanKind.CONSUMER }, (span) =>
          drainConversation(conversation, data, runPromise, signal, span),
        ),
    );
  }

  async function drainConversation(
    conversation: Conversation.Interface,
    data: JobData,
    runPromise: typeof Effect.runPromise,
    signal: AbortSignal | undefined,
    span: Span,
  ) {
    try {
      return await (signal ? runPromise(conversation.drain(data), { signal }) : runPromise(conversation.drain(data)));
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error instanceof Error ? error : String(error));
      if (error instanceof Conversation.ConversationError && !error.retryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  function closeQueue(queue: Queue<JobData>) {
    // Graceful close; the BunRedis layer finalizer quits the underlying client afterwards.
    return Effect.promise(() => queue.close()).pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
  }

  function closeWorker(worker: Worker<JobData>) {
    // Graceful close; if it times out, force-close, then the BunRedis layer
    // finalizer quits the underlying client.
    return Effect.promise(() => worker.close()).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.catch(() =>
        Effect.tryPromise({
          try: () => worker.close(true),
          catch: () => null,
        }),
      ),
      Effect.ignore,
    );
  }
}

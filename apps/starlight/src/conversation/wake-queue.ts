import { RedisClient } from "bun";
import { createBunRedisClient, Queue, UnrecoverableError, Worker } from "bullmq";
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
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

  export class Service extends Context.Service<Service, Interface>()("starlight/ConversationWakeQueue") {}

  export function layer(redisUrl: string, prefix: string): Layer.Layer<Service, WorkerStartupError> {
    return Layer.effect(
      Service,
      Effect.gen(function* make() {
        const redis = createBunRedisClient(new RedisClient(redisUrl));
        const queue = new Queue<JobData>(`${prefix}-lane-wake`, {
          connection: redis,
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        });
        yield* Effect.addFinalizer(() => closeQueue(queue, redis));
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
    );
  }

  export function workerLayer(
    redisUrl: string,
    prefix: string,
  ): Layer.Layer<never, WorkerStartupError, Conversation.Service> {
    return Layer.effectDiscard(
      Effect.gen(function* makeWorker() {
        const conversation = yield* Conversation.Service;
        const redis = createBunRedisClient(new RedisClient(redisUrl));
        const worker = new Worker<JobData>(
          `${prefix}-lane-wake`,
          (job, _token, signal) => processJob(conversation, Schema.decodeUnknownSync(JobData)(job.data), signal),
          {
            connection: redis,
            concurrency: 10,
            lockDuration: 240_000,
          },
        );
        worker.on("error", (error) => {
          void Effect.runPromise(
            Effect.logError("Conversation worker error").pipe(Effect.annotateLogs({ error: error.message })),
          );
        });
        yield* Effect.addFinalizer(() => closeWorker(worker, redis));
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
    );
  }

  function processJob(conversation: Conversation.Interface, data: JobData, signal?: AbortSignal) {
    return context.with(propagation.extract(ROOT_CONTEXT, data), () =>
      trace
        .getTracer("starlight-bot")
        .startActiveSpan("Conversation lane wake", { kind: SpanKind.CONSUMER }, (span) =>
          drainConversation(conversation, data, signal, span),
        ),
    );
  }

  async function drainConversation(
    conversation: Conversation.Interface,
    data: JobData,
    signal: AbortSignal | undefined,
    span: Span,
  ) {
    try {
      return await (signal
        ? Effect.runPromise(conversation.drain(data), { signal })
        : Effect.runPromise(conversation.drain(data)));
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

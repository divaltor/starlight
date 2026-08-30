import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import type { MemoryItemInput, RecallResult } from "@vectorize-io/hindsight-client";
import { Context, Duration, Effect, Layer, Schema } from "effect";

/**
 * Thin wrapper around the external Hindsight service (the "cloud brain").
 *
 *   Hindsight.retain  ──▶ "remember this transcript" (async op, polled
 *                          every 2s, one retry on failure, 10min timeout)
 *   Hindsight.recall  ──▶ "what do you remember about X?" → relevant facts
 *
 * Before either call, ensureBank lazily creates the conversation's memory
 * bank with the retain mission ("extract durable facts, ignore greetings
 * and banter"); it runs once per bank per process, deduplicated via an
 * in-flight map so concurrent calls don't race.
 */
export namespace Hindsight {
  const LEGACY_PROFILE_ID = "profile";
  const OPERATION_POLL_INTERVAL_MS = 2000;
  const OPERATION_TIMEOUT_MS = 600_000;
  const REQUEST_TIMEOUT_MS = 60_000;
  const RETAIN_MISSION = `Each document is either an ordered sequence of human-authored Telegram conversation turns or an explicitly labeled legacy cumulative memory derived from those turns. Extract only durable facts explicitly supported by the document. Resolve first-person language to the named author and preserve exact attribution. Mentioned, quoted, and replied-to people are not the author. Keep durable identity, preferences, work and skills, decisions, commitments, corrections, recurring topics, unresolved situations, blockers, and concrete next steps. Never invent assistant or bot behavior. Omit greetings, one-off banter, weak personality inferences, unsupported sensitive traits, and resolved or outdated state.`;

  export interface Options {
    readonly apiKey: string;
    readonly baseUrl: string;
  }

  export interface RetainInput {
    readonly bankId: string;
    readonly items: readonly MemoryItemInput[];
    readonly operationId: string;
  }

  export interface RecallInput {
    readonly bankId: string;
    readonly maxTokens: number;
    readonly query: string;
  }

  export class HindsightError extends Schema.TaggedError<HindsightError>()("HindsightError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }) {
    static fromCause(message: string, cause: unknown) {
      return new HindsightError({ cause, message });
    }
  }

  export interface Interface {
    readonly recall: (input: RecallInput) => Effect.Effect<readonly RecallResult[], HindsightError>;
    readonly retain: (input: RetainInput) => Effect.Effect<void, HindsightError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Hindsight") {}

  export function layer(options: Options): Layer.Layer<Service> {
    return Layer.succeed(Service, Service.of(make(options)));
  }

  function make(options: Options): Interface {
    const headers = { Authorization: `Bearer ${options.apiKey}` };
    const client = new HindsightClient({ apiKey: options.apiKey, baseUrl: options.baseUrl });
    const generatedClient = createClient(createConfig({ baseUrl: options.baseUrl, headers }));
    const initializedBanks = new Set<string>();
    const initializations = new Map<string, Promise<void>>();

    const ensureBank = (bankId: string, signal: AbortSignal) => {
      if (initializedBanks.has(bankId)) return Promise.resolve();
      const pending = initializations.get(bankId);
      if (pending !== undefined) return pending;

      const initialization = (async () => {
        if (!bankId.startsWith("conversation:")) throw new Error(`Unsupported Hindsight bank: ${bankId}`);
        await client.createBank(bankId, {
          enableObservations: false,
          enableReranking: true,
          retainMission: RETAIN_MISSION,
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        const configured = await sdk.updateBankConfig({
          body: {
            updates: {
              enable_auto_consolidation: false,
              memory_defense: {
                enabled: true,
                rules: [{ action: "redact", on: "sensitive_data" }],
              },
            },
          },
          client: generatedClient,
          path: { bank_id: bankId },
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (configured.error !== undefined) {
          throw new Error(`Hindsight bank configuration failed: ${JSON.stringify(configured.error)}`);
        }
        const models = await client.listMentalModels(bankId, {
          detail: "metadata",
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (models.items.some((model) => model.id === LEGACY_PROFILE_ID)) {
          const deleted = await sdk.deleteMentalModel({
            client: generatedClient,
            path: { bank_id: bankId, mental_model_id: LEGACY_PROFILE_ID },
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (deleted.error !== undefined && deleted.response?.status !== 404) {
            throw new Error(`Hindsight legacy profile deletion failed: ${JSON.stringify(deleted.error)}`);
          }
        }
        initializedBanks.add(bankId);
      })().finally(() => {
        initializations.delete(bankId);
      });
      initializations.set(bankId, initialization);
      return initialization;
    };

    const retain = Effect.fn("Hindsight.retain")(function* retain(input: RetainInput) {
      yield* Effect.tryPromise({
        try: (signal) => ensureBank(input.bankId, signal),
        catch: (cause) => HindsightError.fromCause("Failed to initialize Hindsight bank", cause),
      });
      const submission = yield* Effect.tryPromise({
        try: (signal) =>
          client.retainBatch(input.bankId, [...input.items], {
            async: true,
            operationId: input.operationId,
            signal,
          }),
        catch: (cause) => HindsightError.fromCause("Failed to retain Hindsight memories", cause),
      }).pipe(
        Effect.timeout(Duration.millis(REQUEST_TIMEOUT_MS)),
        Effect.mapError(foldTimeout("Failed to retain Hindsight memories")),
      );
      const operationIds =
        submission.operation_ids ??
        (submission.operation_id === null || submission.operation_id === undefined ? [] : [submission.operation_id]);
      if (operationIds.length === 0) {
        return yield* Effect.fail(
          HindsightError.fromCause("Hindsight async retain returned no operation ID", submission),
        );
      }
      // oxlint-disable-next-line github/array-foreach -- Effect.forEach, not Array.prototype.forEach
      yield* Effect.forEach(operationIds, (operationId) => waitForOperation(input.bankId, operationId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.timeout(Duration.millis(OPERATION_TIMEOUT_MS)),
        Effect.mapError(foldTimeout("Hindsight retain timed out waiting for operations")),
        Effect.withSpan("Hindsight retain", { attributes: { "memory.item_count": input.items.length } }),
      );
    });

    const recall = Effect.fn("Hindsight.recall")(function* recall(input: RecallInput) {
      yield* Effect.tryPromise({
        try: (signal) => ensureBank(input.bankId, signal),
        catch: (cause) => HindsightError.fromCause("Failed to initialize Hindsight bank", cause),
      });
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          client.recall(input.bankId, input.query, {
            budget: "low",
            includeEntities: false,
            maxTokens: input.maxTokens,
            preferObservations: false,
            signal,
            types: ["world"],
          }),
        catch: (cause) => HindsightError.fromCause("Failed to recall Hindsight memory", cause),
      }).pipe(
        Effect.timeout(Duration.millis(REQUEST_TIMEOUT_MS)),
        Effect.mapError(foldTimeout("Failed to recall Hindsight memory")),
        Effect.withSpan("Hindsight recall"),
      );
      return response.results;
    });

    const waitForOperation = Effect.fn("Hindsight.waitForOperation")(function* waitForOperation(
      bankId: string,
      operationId: string,
    ) {
      let retried = false;
      for (;;) {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            sdk.getOperationStatus({
              client: generatedClient,
              path: { bank_id: bankId, operation_id: operationId },
              signal,
            }),
          catch: (cause) => HindsightError.fromCause(`Hindsight operation ${operationId} lookup failed`, cause),
        }).pipe(
          Effect.timeout(Duration.millis(REQUEST_TIMEOUT_MS)),
          Effect.mapError(foldTimeout(`Hindsight operation ${operationId} lookup failed`)),
        );
        if (response.data === undefined) {
          return yield* Effect.fail(
            HindsightError.fromCause(`Hindsight operation ${operationId} lookup failed`, response.error),
          );
        }
        // oxlint-disable-next-line prefer-destructuring -- project style keeps property access explicit
        const status = response.data.status;
        if (status === "completed") return;
        if (status === "failed" && !retried) {
          const retry = yield* Effect.tryPromise({
            try: (signal) =>
              sdk.retryOperation({
                client: generatedClient,
                path: { bank_id: bankId, operation_id: operationId },
                signal,
              }),
            catch: (cause) => HindsightError.fromCause(`Hindsight operation ${operationId} retry failed`, cause),
          }).pipe(
            Effect.timeout(Duration.millis(REQUEST_TIMEOUT_MS)),
            Effect.mapError(foldTimeout(`Hindsight operation ${operationId} retry failed`)),
          );
          if (retry.data === undefined) {
            return yield* Effect.fail(
              HindsightError.fromCause(`Hindsight operation ${operationId} retry failed`, retry.error),
            );
          }
          retried = true;
          continue;
        }
        if (["cancelled", "failed", "not_found"].includes(status)) {
          return yield* Effect.fail(
            HindsightError.fromCause(
              `Hindsight operation ${operationId} ${status}: ${response.data.error_message}`,
              response.data.error_message,
            ),
          );
        }
        yield* Effect.sleep(Duration.millis(OPERATION_POLL_INTERVAL_MS));
      }
    });

    return { recall, retain };
  }

  function foldTimeout(message: string) {
    return (cause: unknown) => (cause instanceof HindsightError ? cause : HindsightError.fromCause(message, cause));
  }
}

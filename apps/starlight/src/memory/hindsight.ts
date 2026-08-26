import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import { Context, Effect, Layer, Schema } from "effect";
import { traceAsync } from "@/instrumentation";

export namespace Hindsight {
  const PROFILE_ID = "profile";
  const OPERATION_POLL_INTERVAL_MS = 2000;
  const OPERATION_TIMEOUT_MS = 600_000;
  const REQUEST_TIMEOUT_MS = 60_000;
  const PROFILE_QUERY =
    "Maintain a compact profile of durable facts, preferences, corrections, decisions, and open work. Preserve exact speaker attribution and omit weak inferences.";
  const RETAIN_MISSION =
    "Extract durable facts, preferences, corrections, decisions, and open work. Preserve exact speaker attribution. Treat corrections as replacements and do not infer sensitive traits from weak evidence.";

  export interface Options {
    readonly apiKey: string;
    readonly baseUrl: string;
  }

  export interface RetainInput {
    readonly bankId: string;
    readonly items: readonly MemoryItemInput[];
    readonly operationId: string;
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
    readonly deleteDocuments: (bankId: string, documentIds: readonly string[]) => Effect.Effect<void, HindsightError>;
    readonly profile: (bankId: string) => Effect.Effect<string | null, HindsightError>;
    readonly refreshProfile: (bankId: string) => Effect.Effect<void, HindsightError>;
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
        await client.createBank(bankId, {
          enableObservations: true,
          enableReranking: true,
          retainMission: RETAIN_MISSION,
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        const configured = await sdk.updateBankConfig({
          body: {
            updates: {
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
        const profile = models.items.find((model) => model.id === PROFILE_ID);
        // oxlint-disable-next-line unicorn/prefer-ternary -- creation has an operation that must complete before refresh
        if (profile === undefined) {
          const created = await client.createMentalModel(bankId, "profile", PROFILE_QUERY, {
            id: PROFILE_ID,
            maxTokens: 800,
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            trigger: { refreshAfterConsolidation: false },
          });
          await waitForOperation(bankId, created.operation_id, signal);
        } else {
          await client.updateMentalModel(bankId, PROFILE_ID, {
            maxTokens: 800,
            name: "profile",
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            sourceQuery: PROFILE_QUERY,
            trigger: { refreshAfterConsolidation: false },
          });
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
        try: (signal) =>
          traceAsync("Hindsight retain", { "memory.item_count": input.items.length }, async () => {
            await ensureBank(input.bankId, signal);
            const submission = await client.retainBatch(input.bankId, [...input.items], {
              async: true,
              operationId: input.operationId,
              signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            });
            const operationIds =
              submission.operation_ids ??
              (submission.operation_id === null || submission.operation_id === undefined
                ? []
                : [submission.operation_id]);
            if (operationIds.length === 0) throw new Error("Hindsight async retain returned no operation ID");
            // Parallel operation polling belongs to the traced retain request.
            // oxlint-disable-next-line sonarjs/no-nested-functions
            await Promise.all(operationIds.map((operationId) => waitForOperation(input.bankId, operationId, signal)));
          }),
        catch: (cause) => HindsightError.fromCause("Failed to retain Hindsight memories", cause),
      });
    });

    const profile = Effect.fn("Hindsight.profile")(function* profile(bankId: string) {
      return yield* Effect.tryPromise({
        try: (signal) =>
          traceAsync("Hindsight profile read", {}, async () => {
            await ensureBank(bankId, signal);
            const model = await client.getMentalModel(bankId, PROFILE_ID, {
              detail: "content",
              signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            });
            return model.content ?? null;
          }),
        catch: (cause) => HindsightError.fromCause("Failed to read Hindsight profile", cause),
      });
    });

    const deleteDocuments = Effect.fn("Hindsight.deleteDocuments")(function* deleteDocuments(
      bankId: string,
      documentIds: readonly string[],
    ) {
      yield* Effect.tryPromise({
        try: (signal) => ensureBank(bankId, signal),
        catch: (cause) => HindsightError.fromCause("Failed to initialize Hindsight bank", cause),
      });
      yield* Effect.all(
        documentIds.map((documentId) =>
          Effect.tryPromise({
            try: async (signal) => {
              const response = await sdk.deleteDocument({
                client: generatedClient,
                path: { bank_id: bankId, document_id: documentId },
                signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
              });
              if (response.error !== undefined && response.response?.status !== 404) {
                throw new Error(`Hindsight document deletion failed: ${JSON.stringify(response.error)}`);
              }
            },
            catch: (cause) => HindsightError.fromCause("Failed to delete Hindsight document", cause),
          }),
        ),
        { concurrency: 5, discard: true },
      );
    });

    const refreshProfile = Effect.fn("Hindsight.refreshProfile")(function* refreshProfile(bankId: string) {
      yield* Effect.tryPromise({
        try: (signal) =>
          traceAsync("Hindsight profile refresh", {}, async () => {
            await ensureBank(bankId, signal);
            const submission = await client.refreshMentalModel(bankId, PROFILE_ID, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            });
            await waitForOperation(bankId, submission.operation_id, signal);
          }),
        catch: (cause) => HindsightError.fromCause("Failed to refresh Hindsight profile", cause),
      });
    });

    async function waitForOperation(bankId: string, operationId: string, signal: AbortSignal): Promise<void> {
      const deadline = Date.now() + OPERATION_TIMEOUT_MS;
      let retried = false;
      for (;;) {
        const response = await sdk.getOperationStatus({
          client: generatedClient,
          path: { bank_id: bankId, operation_id: operationId },
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (response.data === undefined) {
          throw new Error(`Hindsight operation lookup failed: ${JSON.stringify(response.error)}`);
        }
        // oxlint-disable-next-line prefer-destructuring -- project style keeps property access explicit
        const status = response.data.status;
        if (status === "completed") return;
        if (status === "failed" && !retried) {
          const retry = await sdk.retryOperation({
            client: generatedClient,
            path: { bank_id: bankId, operation_id: operationId },
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (retry.data === undefined) {
            throw new Error(`Hindsight operation retry failed: ${JSON.stringify(retry.error)}`);
          }
          retried = true;
          continue;
        }
        if (["cancelled", "failed", "not_found"].includes(status)) {
          throw new Error(`Hindsight operation ${operationId} ${status}: ${response.data.error_message}`);
        }
        if (Date.now() >= deadline) throw new Error(`Hindsight operation ${operationId} timed out`);
        await Bun.sleep(OPERATION_POLL_INTERVAL_MS);
      }
    }

    return { deleteDocuments, profile, refreshProfile, retain };
  }
}

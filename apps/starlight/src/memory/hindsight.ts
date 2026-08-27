import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import type { MemoryItemInput, RecallResult } from "@vectorize-io/hindsight-client";
import { Context, Effect, Layer, Schema } from "effect";

export namespace Hindsight {
  const LEGACY_PROFILE_ID = "profile";
  const OPERATION_POLL_INTERVAL_MS = 2000;
  const OPERATION_TIMEOUT_MS = 600_000;
  const REQUEST_TIMEOUT_MS = 60_000;
  const USER_RETAIN_MISSION = `Each document is a Telegram message authored by the person identified in content.author. Extract only durable facts explicitly supported by that author's words. Resolve first-person language to content.author. Never reinterpret the author's statements as actions or requests addressed to an unnamed user. A mentioned, quoted, or replied-to person is not the author. Preserve complete observed identity and aliases, durable preferences, work and skills, decisions, commitments, corrections, and ongoing personal context. Statements about other people must remain attributed claims, not facts about the author. Omit one-off banter, weak personality inferences, and unsupported sensitive traits.`;
  const CHAT_RETAIN_MISSION = `Each document is a message in one Telegram group chat. content.author authored the message; first-person language refers to that author. Mentioned and replied-to people are different unless explicitly identified as the same person. Extract durable member facts with exact attribution and preserve mappings between names, usernames, and observed aliases. Also extract recurring chat topics, group decisions, relationships, scheduled work, and unresolved situations. Do not infer stable personality from isolated jokes or record assistant and bot behavior as member facts.`;
  const TOPIC_RETAIN_MISSION = `Each document is a message in one Telegram topic. Resolve first-person language to content.author and preserve exact speaker attribution. Extract only topic-relevant decisions, responsibilities, corrections, unresolved questions, ongoing intent, blockers, and concrete next steps. Keep replied-to text as context, not as a statement authored by the current sender. Drop resolved and outdated topic state and do not create broad personality profiles.`;
  const BANK_CONFIGS = [
    { prefix: "user:", retainMission: USER_RETAIN_MISSION },
    { prefix: "chat:", retainMission: CHAT_RETAIN_MISSION },
    { prefix: "topic:", retainMission: TOPIC_RETAIN_MISSION },
  ] as const;

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
    readonly deleteDocuments: (bankId: string, documentIds: readonly string[]) => Effect.Effect<void, HindsightError>;
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
        const bankConfig = BANK_CONFIGS.find((config) => bankId.startsWith(config.prefix));
        if (bankConfig === undefined) throw new Error(`Unsupported Hindsight bank: ${bankId}`);
        await client.createBank(bankId, {
          enableObservations: true,
          enableReranking: true,
          retainMission: bankConfig.retainMission,
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
        try: async (signal) => {
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
          await Promise.all(operationIds.map((operationId) => waitForOperation(input.bankId, operationId, signal)));
        },
        catch: (cause) => HindsightError.fromCause("Failed to retain Hindsight memories", cause),
      }).pipe(Effect.withSpan("Hindsight retain", { attributes: { "memory.item_count": input.items.length } }));
    });

    const recall = Effect.fn("Hindsight.recall")(function* recall(input: RecallInput) {
      return yield* Effect.tryPromise({
        try: async (signal) => {
          await ensureBank(input.bankId, signal);
          const response = await client.recall(input.bankId, input.query, {
            budget: "low",
            includeEntities: false,
            maxTokens: input.maxTokens,
            preferObservations: true,
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            types: ["world", "experience", "observation"],
          });
          return response.results;
        },
        catch: (cause) => HindsightError.fromCause("Failed to recall Hindsight memory", cause),
      }).pipe(Effect.withSpan("Hindsight recall"));
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

    return { deleteDocuments, recall, retain };
  }
}

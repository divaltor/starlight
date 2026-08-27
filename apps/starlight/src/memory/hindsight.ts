import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import type { MemoryItemInput } from "@vectorize-io/hindsight-client";
import { Context, Effect, Layer, Schema } from "effect";

export namespace Hindsight {
  const PROFILE_ID = "profile";
  const OPERATION_POLL_INTERVAL_MS = 2000;
  const OPERATION_TIMEOUT_MS = 600_000;
  const REQUEST_TIMEOUT_MS = 60_000;
  const USER_PROFILE_QUERY = `Create a compact factual profile of the single human who authored the source messages in this bank. Refer to that person by the most complete observed name and @username, never generically as "the user".

Include only identity and aliases, durable self-authored facts, stable preferences and recurring interests, work and skills, decisions, commitments, open personal work, and explicit corrections that replace older facts. Distinguish facts about the profile subject from things they said about other people. Do not describe their messages as actions addressed to another user. Omit unsupported inferences, one-off jokes, chronology, missing-data commentary, and outdated facts.`;
  const CHAT_PROFILE_QUERY = `Produce private chat-wide background for future replies.

Members:
- One concise bullet per known human member.
- Show the best observed name, @username, aliases, and only well-supported durable facts.
- Preserve exact attribution and do not merge people who share a first name.
- Exclude the assistant and bots.

Chat notes:
- Keep 5-10 concise bullets covering recurring topics, stable group dynamics, ongoing situations, decisions, scheduled work, and unresolved matters.
- Drop resolved, outdated, and one-off material.

Use neutral factual language. Never turn one member's statement about another member into a fact about the speaker.`;
  const TOPIC_PROFILE_QUERY = `Produce a private current-state note for this topic only, using 3-6 concise bullets.

Keep what is being discussed or attempted, decisions and corrections, responsibilities with exact person attribution, unresolved questions, blockers, and next steps. Drop resolved, outdated, chat-wide, and one-off material. Exclude assistant and bot actions as facts.`;
  const USER_RETAIN_MISSION = `Each document is a Telegram message authored by the person identified in content.author. Extract only durable facts explicitly supported by that author's words. Resolve first-person language to content.author. Never reinterpret the author's statements as actions or requests addressed to an unnamed user. A mentioned, quoted, or replied-to person is not the author. Preserve complete observed identity and aliases, durable preferences, work and skills, decisions, commitments, corrections, and ongoing personal context. Statements about other people must remain attributed claims, not facts about the author. Omit one-off banter, weak personality inferences, and unsupported sensitive traits.`;
  const CHAT_RETAIN_MISSION = `Each document is a message in one Telegram group chat. content.author authored the message; first-person language refers to that author. Mentioned and replied-to people are different unless explicitly identified as the same person. Extract durable member facts with exact attribution and preserve mappings between names, usernames, and observed aliases. Also extract recurring chat topics, group decisions, relationships, scheduled work, and unresolved situations. Do not infer stable personality from isolated jokes or record assistant and bot behavior as member facts.`;
  const TOPIC_RETAIN_MISSION = `Each document is a message in one Telegram topic. Resolve first-person language to content.author and preserve exact speaker attribution. Extract only topic-relevant decisions, responsibilities, corrections, unresolved questions, ongoing intent, blockers, and concrete next steps. Keep replied-to text as context, not as a statement authored by the current sender. Drop resolved and outdated topic state and do not create broad personality profiles.`;
  const PROFILE_CONFIGS = [
    { maxTokens: 1500, prefix: "user:", query: USER_PROFILE_QUERY, retainMission: USER_RETAIN_MISSION },
    { maxTokens: 2500, prefix: "chat:", query: CHAT_PROFILE_QUERY, retainMission: CHAT_RETAIN_MISSION },
    { maxTokens: 800, prefix: "topic:", query: TOPIC_PROFILE_QUERY, retainMission: TOPIC_RETAIN_MISSION },
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
    readonly reconcileBank: (bankId: string) => Effect.Effect<void, HindsightError>;
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
        const profileConfig = PROFILE_CONFIGS.find((config) => bankId.startsWith(config.prefix));
        if (profileConfig === undefined) throw new Error(`Unsupported Hindsight bank: ${bankId}`);
        await client.createBank(bankId, {
          enableObservations: true,
          enableReranking: true,
          retainMission: profileConfig.retainMission,
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
        if (profile === undefined) {
          const created = await sdk.createMentalModel({
            body: {
              id: PROFILE_ID,
              max_tokens: profileConfig.maxTokens,
              name: "profile",
              source_query: profileConfig.query,
              trigger: { mode: "delta", refresh_after_consolidation: true },
            },
            client: generatedClient,
            path: { bank_id: bankId },
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (created.data === undefined) {
            throw new Error(`Hindsight mental model creation failed: ${JSON.stringify(created.error)}`);
          }
        } else {
          const profileDefinitionChanged =
            profile.source_query !== profileConfig.query || profile.max_tokens !== profileConfig.maxTokens;
          const updated = await sdk.updateMentalModel({
            body: {
              max_tokens: profileConfig.maxTokens,
              name: "profile",
              source_query: profileConfig.query,
              trigger: { mode: "delta", refresh_after_consolidation: true },
            },
            client: generatedClient,
            path: { bank_id: bankId, mental_model_id: PROFILE_ID },
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (updated.data === undefined) {
            throw new Error(`Hindsight mental model update failed: ${JSON.stringify(updated.error)}`);
          }
          if (profileDefinitionChanged) {
            await client.refreshMentalModel(bankId, PROFILE_ID, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            });
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

    const profile = Effect.fn("Hindsight.profile")(function* profile(bankId: string) {
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await sdk.getMentalModel({
            client: generatedClient,
            path: { bank_id: bankId, mental_model_id: PROFILE_ID },
            query: { detail: "content" },
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (response.response?.status === 404) return null;
          if (response.data === undefined) {
            throw new Error(`Hindsight profile read failed: ${JSON.stringify(response.error)}`);
          }
          return response.data.content === "Generating content..." ? null : (response.data.content ?? null);
        },
        catch: (cause) => HindsightError.fromCause("Failed to read Hindsight profile", cause),
      }).pipe(Effect.withSpan("Hindsight profile read"));
    });

    const reconcileBank = Effect.fn("Hindsight.reconcileBank")(function* reconcileBank(bankId: string) {
      yield* Effect.tryPromise({
        try: (signal) => ensureBank(bankId, signal),
        catch: (cause) => HindsightError.fromCause("Failed to reconcile Hindsight bank", cause),
      }).pipe(Effect.withSpan("Hindsight bank reconciliation"));
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
        try: async (signal) => {
          await ensureBank(bankId, signal);
          const submission = await client.refreshMentalModel(bankId, PROFILE_ID, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          await waitForOperation(bankId, submission.operation_id, signal);
        },
        catch: (cause) => HindsightError.fromCause("Failed to refresh Hindsight profile", cause),
      }).pipe(Effect.withSpan("Hindsight profile refresh"));
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

    return { deleteDocuments, profile, reconcileBank, refreshProfile, retain };
  }
}

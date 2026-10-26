import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import { openNodePostgresStorage } from "@netzlabor/pi-durable-postgres";
import { context, propagation } from "@opentelemetry/api";
import { Context, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import type { Chat as TelegramChat } from "grammy/types";
import { ChatTools } from "@/ai/chat-tools";
import { Model } from "@/ai/model";
import { ModelProfile } from "@/ai/model-profile";
import { OpenRouter } from "@/ai/openrouter";
import { Checkpoint } from "@/context/checkpoint";
import { TelegramDelivery } from "@/conversation/delivery";
import { Dispatch } from "@/conversation/dispatch";
import { ConversationKey } from "@/conversation/key";
import { Lane } from "@/conversation/lane";
import { LaneDoc } from "@/conversation/lane-doc";
import { LegacyImport } from "@/conversation/legacy-import";
import type { InputPayload } from "@/conversation/run-artifacts";
import { Reply } from "@/conversation/reply";
import { createPiTelemetry } from "@/instrumentation";
import { Memory } from "@/memory/memory";
import { RecallQuery } from "@/memory/recall-query";
import { Media } from "@/media/media";
import { Database } from "@/services/database";

/**
 * Telegram conversations on a Pi Durable harness. Telegram facts (chats, users, messages) stay
 * in Prisma tables; everything about running a conversation (batching, runs, transcripts,
 * compaction, delivery, crash recovery) lives in the harness's own `durable` schema, which one
 * process owns at a time through the storage's advisory lock.
 */
export namespace Conversation {
  const DURABLE_SCHEMA = "durable";
  // Room for compaction to start in the background before a request must wait for it.
  const BACKGROUND_COMPACTION_TOKENS = 8000;

  export interface AdmissionInput {
    readonly chatTitle: string | null;
    readonly chatType: TelegramChat["type"];
    readonly chatUsername: string | null;
    readonly key: ConversationKey.Value;
    readonly payload: InputPayload;
    readonly updateId: number;
  }

  export interface AdmissionResult {
    readonly duplicate: boolean;
  }

  export class AdmissionError extends Schema.TaggedError<AdmissionError>()("AdmissionError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  }) {}

  export class ReadError extends Schema.TaggedError<ReadError>()("ConversationReadError", {
    cause: Schema.Defect(),
    message: Schema.String,
  }) {}

  export class StartupError extends Schema.TaggedError<StartupError>()("ConversationStartupError", {
    cause: Schema.Defect(),
    message: Schema.String,
  }) {}

  export interface Interface {
    readonly admit: (input: AdmissionInput) => Effect.Effect<AdmissionResult, AdmissionError>;
    // The lane's recent messages and delivered replies, oldest first.
    readonly recent: (key: ConversationKey.Value) => Effect.Effect<readonly LaneDoc.Recent[], ReadError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Conversation") {}

  export interface Options {
    readonly contextCompactionTriggerTokens: number;
    readonly contextRetainedTokenTarget: number;
    readonly databaseUrl: string;
    readonly maxWaitMs: number;
    readonly openRouterApiKey: string;
    readonly quietMs: number;
    readonly recallMaxQueryTokens: number;
  }

  export class OptionsService extends Context.Service<OptionsService, Options>()("starlight/ConversationOptions") {}

  export const optionsLayer = Layer.succeed(OptionsService);

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const database = yield* Database.Service;
      const chatTools = yield* ChatTools.Service;
      const delivery = yield* TelegramDelivery.Service;
      const media = yield* Media.Service;
      const memory = yield* Memory.Service;
      const model = yield* Model.Service;
      const options = yield* OptionsService;
      const run = Effect.runPromiseWith(yield* Effect.context());
      const profile = ModelProfile.selected;
      const timing = { maxWaitMs: options.maxWaitMs, quietMs: options.quietMs };

      const agent = {
        model: { modelId: profile.model, provider: OpenRouter.providerId },
        thinkingLevel: "low",
      } as const;

      const research = yield* chatTools.resolve(chatTools.availableProfile).pipe(Effect.orDie);

      const log: Lane.Deps["log"] = (level, message, fields) => {
        const effect = { error: Effect.logError, info: Effect.logInfo, warn: Effect.logWarning }[level](message);
        void run(effect.pipe(Effect.annotateLogs(fields)));
      };

      const deliveryTask = Dispatch.task({
        deliver: async (input) =>
          await run(
            delivery.deliver(input).pipe(
              Effect.map((receipt) => ({ receipt })),
              Effect.catch((error) => Effect.succeed({ error })),
            ),
          ),
        random: Math.random,
      });

      const laneTask = Lane.task({
        chat: async (chatId) =>
          await run(
            database.query(
              async (client) =>
                await client.chat.findUnique({
                  where: { id: BigInt(chatId) },
                  select: { isPremium: true, isPrivate: true, title: true },
                }),
            ),
          ),
        delivery: deliveryTask,
        log,
        recall: async (key, batch) => {
          const recalled = await run(
            memory.recall({
              key: ConversationKey.toDb(key),
              query: RecallQuery.build({
                inputs: batch.map((item) => item.payload),
                maxTokens: options.recallMaxQueryTokens,
              }),
            }),
          );

          return recalled.contextMemory;
        },
        record: async (key, batch) => {
          await run(memory.record(ConversationKey.toDb(key), batch));
        },
        timing,
        typing: async (key) => {
          await run(delivery.indicateTyping({ chatId: key.chatId, threadKey: key.threadKey }).pipe(Effect.ignore));
        },
      });

      const registry = createRegistry();

      registry.install(
        Reply.extension({
          delivery: deliveryTask,
          flushMemory: async (key) => {
            await run(memory.flush(ConversationKey.toDb(key)));
          },
          loadMedia: async (references) => {
            const loaded = await run(Effect.all(references.map(media.load), { concurrency: "unbounded" }));

            return loaded.filter(Predicate.isNotNull);
          },
          research: research.tools,
          summarize: async (input) => {
            const generated = await run(
              model.generate({
                instructions: Checkpoint.summaryInstructions,
                maxOutputTokens: 2048,
                maxToolCalls: 0,
                maxToolOutputBytes: 0,
                messages: [{ role: "user", text: input }],
                outputSchema: Checkpoint.Records,
                sessionId: "checkpoint",
                telemetryFunctionId: "conversation-checkpoint",
                tools: {},
              }),
            );

            return Checkpoint.renderRecords(generated.output);
          },
        }),
      );
      registry.install(defineExtension({ name: "starlight.lanes", tasks: [laneTask] }));

      const telemetry = createPiTelemetry();
      const models = createModels();
      models.setProvider(OpenRouter.provider(options.openRouterApiKey, profile));

      yield* database
        .query(async (client) => await client.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${DURABLE_SCHEMA}`))
        .pipe(Effect.mapError((cause) => new StartupError({ cause, message: "Failed to create the durable schema" })));

      const open = Effect.tryPromise({
        try: async () => {
          const storage = await openNodePostgresStorage({
            config: {
              connectionString: options.databaseUrl,
              connectionTimeoutMillis: 5000,
              max: 1,
              options: `-c search_path=${DURABLE_SCHEMA}`,
            },
          });

          const opened = await Harness.open(
            storage,
            {
              models,
              onReport: (error, info) => {
                log("error", "Conversation harness reported a failure", { error: String(error), type: info.type });
              },
              registry,
              settings: {
                compaction: {
                  modelOverrides: {
                    [`${OpenRouter.providerId}/${profile.model}`]: {
                      backgroundTokens: BACKGROUND_COMPACTION_TOKENS,
                      keepRecentTokens: options.contextRetainedTokenTarget,
                      reserveTokens: OpenRouter.model(profile).contextWindow - options.contextCompactionTriggerTokens,
                    },
                  },
                },
                // Five attempts in total, as before.
                retry: { maxRetries: 4 },
                stream: { timeoutMs: 40_000 },
              },
              telemetry,
            },
            BACKGROUND_CONTEXT,
          );

          opened.resume();

          return opened;
        },
        catch: (cause) => new StartupError({ cause, message: "Failed to open the conversation harness" }),
      });

      let harness = yield* open;

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await harness.close(BACKGROUND_CONTEXT);
        }),
      );

      // Before admissions start, so no new message can open a lane its history has not reached.
      yield* LegacyImport.run(harness, { agent, timing }).pipe(
        Effect.mapError((cause) => new StartupError({ cause, message: "Failed to import legacy conversations" })),
      );

      // The first failed Storage call (e.g. a dropped connection) closes the harness for good; reopening resumes
      // from what was committed. Forked after the finalizer, so shutdown stops it before closing the harness.
      yield* Effect.forkScoped(
        Effect.gen(function* reopen() {
          const end = yield* Effect.promise(async () => await harness.closed);

          yield* Effect.logError("Conversation harness closed, reopening").pipe(
            Effect.annotateLogs({ error: end.reason === "failed" ? String(end.error) : end.reason }),
          );

          harness = yield* open.pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Conversation harness reopen failed").pipe(
                Effect.annotateLogs({ error: String(error.cause) }),
              ),
            ),
            Effect.retry(Schedule.spaced("5 seconds")),
          );

          yield* Effect.logInfo("Conversation harness reopened");
        }).pipe(Effect.forever),
      );

      const admit = Effect.fn("Conversation.admit")(function* admit(input: AdmissionInput) {
        const senderUserId = yield* database
          .transaction(async (transaction) => {
            await transaction.chat.upsert({
              where: { id: BigInt(input.key.chatId) },
              create: {
                id: BigInt(input.key.chatId),
                // Direct messages stay private by default; groups opt in via the flag.
                isPrivate: input.chatType === "private",
                title: input.chatTitle,
                username: input.chatUsername,
              },
              update: { title: input.chatTitle, username: input.chatUsername },
            });

            const sender =
              input.payload.senderId === null
                ? null
                : await transaction.user.upsert({
                    where: { telegramId: BigInt(input.payload.senderId) },
                    create: {
                      firstName: input.payload.senderFirstName,
                      isBot: input.payload.senderIsBot ?? false,
                      lastName: input.payload.senderLastName ?? null,
                      telegramId: BigInt(input.payload.senderId),
                      username: input.payload.senderUsername,
                    },
                    update: {
                      firstName: input.payload.senderFirstName,
                      isBot: input.payload.senderIsBot ?? false,
                      lastName: input.payload.senderLastName ?? null,
                      username: input.payload.senderUsername,
                    },
                  });

            const rawMessage = {
              caption: input.payload.media.length > 0 ? input.payload.text : null,
              chatId: BigInt(input.key.chatId),
              date: new Date(input.payload.date * 1000),
              editDate: input.payload.editDate === null ? null : new Date(input.payload.editDate * 1000),
              forwardOrigin: input.payload.forwardOrigin,
              fromFirstName: input.payload.senderFirstName,
              fromId: input.payload.senderId === null ? null : BigInt(input.payload.senderId),
              fromUsername: input.payload.senderUsername,
              messageId: input.payload.messageId,
              messageThreadId: input.key.threadKey === 0 ? null : input.key.threadKey,
              rawData: input.payload,
              replyToMessageId: input.payload.replyToMessageId,
              text: input.payload.media.length > 0 ? null : input.payload.text,
            };

            await transaction.message.upsert({
              where: { messageId_chatId: { chatId: BigInt(input.key.chatId), messageId: input.payload.messageId } },
              create: rawMessage,
              update: rawMessage,
            });

            return sender?.id ?? null;
          })
          .pipe(Effect.mapError(admissionFailed));

        const admitted = yield* Effect.tryPromise({
          try: async () => {
            // The lane links its phases to this admission, so a reply can be traced back to its updates.
            const trace: TelemetryCarrier = {};
            propagation.inject(context.active(), trace);

            return await harness.commit(
              async (tx) =>
                await Lane.admit(tx, {
                  agent,
                  // Pi documents are strict JSON, so an empty carrier is omitted rather than left undefined.
                  item: { payload: input.payload, senderUserId, ...(trace.traceparent !== undefined && { trace }) },
                  key: input.key,
                  now: Date.now(),
                  task: laneTask,
                  timing,
                  updateId: input.updateId,
                }),
              BACKGROUND_CONTEXT,
            );
          },
          catch: admissionFailed,
        });

        yield* Effect.logInfo("Conversation input admitted").pipe(
          Effect.annotateLogs({
            conversationKey: ConversationKey.format(input.key),
            duplicate: admitted.duplicate,
            messageId: input.payload.messageId,
          }),
        );

        return admitted;
      });

      const recent = Effect.fn("Conversation.recent")(function* recent(key: ConversationKey.Value) {
        // The first read after a dropped connection fails and closes the harness; the retry reads the reopened one.
        return yield* Effect.tryPromise({
          try: async () => {
            const index = await harness.snapshot(LaneDoc.index, ConversationKey.format(key), BACKGROUND_CONTEXT);

            if (index?.conversationId == null) return [];

            const lane = await harness.snapshot(LaneDoc.token, index.conversationId, BACKGROUND_CONTEXT);

            return lane?.recent ?? [];
          },
          catch: (cause) => new ReadError({ cause, message: "Failed to read recent conversation messages" }),
        }).pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 2 }));
      });

      return Service.of({ admit, recent });
    }),
  );

  function admissionFailed(cause: unknown) {
    return new AdmissionError({ cause, message: "Failed to admit conversation input", retryable: true });
  }
}

import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModel } from "ai";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import type { ConversationKey } from "@/conversation/key";
import type { InputPayload } from "@/conversation/run-artifacts";
import { Database } from "@/services/database";

export namespace DialogueContinuation {
  const RESPONSE_THRESHOLD = 0.8;

  export interface Input {
    readonly key: ConversationKey.Value;
    readonly messageId: number;
    readonly senderFirstName: string;
    readonly senderId: number | null;
    readonly text: string;
  }

  export class EvaluationError extends Schema.TaggedError<EvaluationError>()("DialogueContinuationEvaluationError", {
    cause: Schema.Defect(),
    message: Schema.String,
  }) {
    static fromCause(cause: unknown) {
      return new EvaluationError({ cause, message: "Failed to evaluate dialogue continuation" });
    }
  }

  export interface Interface {
    readonly shouldRespond: (input: Input) => Effect.Effect<boolean, EvaluationError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/DialogueContinuation") {}

  export function layer(
    model: Experimental_EvaluationModel,
    options: { readonly messageLimit: number },
  ): Layer.Layer<Service, never, Database.Service> {
    return Layer.effect(
      Service,
      Effect.gen(function* make() {
        const database = yield* Database.Service;
        const shouldRespond = Effect.fn("DialogueContinuation.shouldRespond")(function* shouldRespond(input: Input) {
          const latestReply = yield* database
            .query((client) =>
              client.conversationRunAction.findFirst({
                where: {
                  deliveryStatus: "delivered",
                  telegramMessageId: { lt: input.messageId },
                  type: "text",
                  run: {
                    assistantId: BigInt(input.key.assistantId),
                    chatId: BigInt(input.key.chatId),
                    threadKey: input.key.threadKey,
                  },
                },
                orderBy: { telegramMessageId: "desc" },
                select: {
                  telegramMessageId: true,
                  run: {
                    select: {
                      actions: {
                        where: { deliveryStatus: "delivered", type: "text" },
                        orderBy: { ordinal: "asc" },
                        select: { payload: true },
                      },
                      inputs: {
                        orderBy: { ordinal: "asc" },
                        select: { input: { select: { payload: true } } },
                      },
                    },
                  },
                },
              }),
            )
            .pipe(Effect.mapError(EvaluationError.fromCause));
          if (latestReply?.telegramMessageId === null || latestReply?.telegramMessageId === undefined) return false;
          const replyMessageId = latestReply.telegramMessageId;

          const messagesAfterReply = yield* database
            .query((client) =>
              client.message.findMany({
                where: {
                  chatId: BigInt(input.key.chatId),
                  messageId: { gt: replyMessageId, lt: input.messageId },
                  messageThreadId: input.key.threadKey === 0 ? null : input.key.threadKey,
                },
                orderBy: { messageId: "asc" },
                select: { caption: true, fromFirstName: true, fromId: true, text: true },
                take: options.messageLimit,
              }),
            )
            .pipe(Effect.mapError(EvaluationError.fromCause));
          if (messagesAfterReply.length >= options.messageLimit) return false;

          const recentExchange = [
            ...latestReply.run.inputs.map((runInput) => {
              const payload = runInput.input.payload as InputPayload;
              return {
                speaker: payload.senderFirstName,
                speakerId: payload.senderId?.toString() ?? "unknown",
                text: payload.text || "[non-text message]",
              };
            }),
            ...latestReply.run.actions.flatMap((action) => {
              const parsed = ChatReply.actionSchema.parse(action.payload);
              return parsed.type === "text"
                ? [{ speaker: "Starlight", speakerId: "assistant", text: parsed.text }]
                : [];
            }),
          ];
          const currentMessage = {
            speaker: input.senderFirstName,
            speakerId: input.senderId?.toString() ?? "unknown",
            text: input.text,
          };
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              experimental_evaluate({
                abortSignal: signal,
                maxRetries: 2,
                model,
                questions: {
                  continuation: {
                    type: "boolean",
                    instructions:
                      "Should Starlight treat `currentMessage` as a continuation addressed to her and respond? Decide conversational addressee and intent, not merely topic similarity.",
                    criteria: {
                      true: "The current message naturally follows Starlight's recent reply and seeks her answer, reaction, clarification, or participation, even without mentioning or replying to her explicitly.",
                      false:
                        "The current message is directed at another participant, unrelated, self-contained chat among humans, or only an acknowledgement or closer that does not need a response.",
                    },
                  },
                },
                state: {
                  currentMessage,
                  explicitAddressing: false,
                  messagesAfterAssistant: [
                    ...messagesAfterReply.map((message) => ({
                      speaker: message.fromFirstName ?? "unknown",
                      speakerId: message.fromId?.toString() ?? "unknown",
                      text: message.text ?? message.caption ?? "[non-text message]",
                    })),
                    currentMessage,
                  ],
                  recentExchange,
                },
              }),
            catch: EvaluationError.fromCause,
          }).pipe(Effect.timeout(Duration.seconds(10)), Effect.mapError(EvaluationError.fromCause));
          const respond = result.answers.continuation.probability >= RESPONSE_THRESHOLD;
          yield* Effect.logDebug("Dialogue continuation evaluated").pipe(
            Effect.annotateLogs({
              chatId: input.key.chatId,
              messageId: input.messageId,
              probability: result.answers.continuation.probability,
              respond,
              threadKey: input.key.threadKey,
            }),
          );
          return respond;
        });

        return Service.of({ shouldRespond });
      }),
    );
  }
}

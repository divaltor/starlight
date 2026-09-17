import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModel } from "ai";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import type { TelegramDelivery } from "@/conversation/delivery";
import type { ConversationKey } from "@/conversation/key";
import type { InputPayload } from "@/conversation/run-artifacts";
import { Database } from "@/services/database";

export namespace DialogueContinuation {
  const ACTION_THRESHOLD = 0.8;

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

  export type Decision =
    | { readonly type: "silence" }
    | { readonly type: "text" }
    | { readonly emoji: TelegramDelivery.ReactionEmoji; readonly type: "reaction" };

  export interface Interface {
    readonly evaluate: (input: Input) => Effect.Effect<Decision, EvaluationError>;
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
        const evaluate = Effect.fn("DialogueContinuation.evaluate")(function* evaluate(input: Input) {
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
          if (latestReply?.telegramMessageId === null || latestReply?.telegramMessageId === undefined) {
            return { type: "silence" } as const;
          }
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
          if (messagesAfterReply.length >= options.messageLimit) return { type: "silence" } as const;

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
                  action: {
                    type: "choice",
                    instructions:
                      "What is the most natural action for Starlight toward `currentMessage`? Judge whether it is addressed to her and what social response it warrants.",
                    criteria: {
                      text: "Write substantive text because the message seeks an answer, clarification, opinion, correction, or meaningful participation from Starlight.",
                      reaction:
                        "Add one Telegram emoji reaction as a lightweight acknowledgement because the message is addressed to Starlight but words would unnecessarily prolong the exchange.",
                      silence:
                        "Do nothing because the message is directed elsewhere, unrelated, or a routine closer where even a reaction would add little.",
                    },
                  },
                  emoji: {
                    type: "choice",
                    instructions:
                      "If Starlight reacts to `currentMessage`, which available Telegram emoji best matches its meaning and emotional intensity?",
                    criteria: {
                      "😁": "Warm amusement or cheerful delight",
                      "🤮": "Strong disgust",
                      "🤡": "Mocking something foolish",
                      "🤔": "Thoughtful doubt or curiosity",
                      "😭": "Overwhelming laughter, emotion, or sadness when clearly intense",
                      "🥰": "Affection or warm appreciation",
                      "😡": "Anger",
                      "🔥": "Enthusiastic praise or something impressive",
                      "👏": "Congratulations or applause",
                      "👌": "Approval or acknowledgement",
                      "👎": "Disapproval",
                      "👍": "Simple agreement, thanks acknowledgement, or confirmation",
                      "💔": "Heartbreak or sympathy",
                      "💯": "Strong agreement or emphatic approval",
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
          const action = result.answers.action.choice;
          const probability = result.answers.action.probabilities?.[action] ?? 0;
          const candidate: Record<typeof action, Decision> = {
            reaction: { emoji: result.answers.emoji.choice, type: "reaction" },
            silence: { type: "silence" },
            text: { type: "text" },
          };
          const decision = probability < ACTION_THRESHOLD ? { type: "silence" as const } : candidate[action];
          yield* Effect.logDebug("Dialogue continuation evaluated").pipe(
            Effect.annotateLogs({
              action,
              chatId: input.key.chatId,
              decision: decision.type,
              emoji: decision.type === "reaction" ? decision.emoji : null,
              messageId: input.messageId,
              probability,
              threadKey: input.key.threadKey,
            }),
          );
          return decision;
        });

        return Service.of({ evaluate });
      }),
    );
  }
}

import { Api, GrammyError } from "grammy";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { OperationalTelemetry } from "@/operational-telemetry";

export namespace TelegramDelivery {
  // Telegram only accepts this fixed reaction emoji set; model output is validated
  // against it at both parse boundaries (fresh generation and stored payload).
  export const reactionEmojis = [
    "😁",
    "🤮",
    "🤡",
    "🤔",
    "😭",
    "🥰",
    "😡",
    "🔥",
    "👏",
    "👌",
    "👎",
    "👍",
    "💔",
    "💯",
  ] as const;

  export type ReactionEmoji = (typeof reactionEmojis)[number];

  export interface IgnoreAction {
    readonly type: "ignore";
  }

  export interface ReactionAction {
    readonly emoji: ReactionEmoji;
    readonly messageId: number;
    readonly type: "reaction";
  }

  export interface TextAction {
    readonly replyTo?: number | null;
    readonly text: string;
    readonly type: "text";
  }

  export type Action = IgnoreAction | ReactionAction | TextAction;

  export interface DeliveryInput {
    readonly action: Action;
    readonly chatId: number;
    readonly threadKey: number;
  }

  export interface TypingInput {
    readonly chatId: number;
    readonly threadKey: number;
  }

  export interface Receipt {
    readonly telegramMessageId: number | null;
  }

  export class DeliveryError extends Schema.TaggedError<DeliveryError>()("DeliveryError", {
    cause: Schema.Defect(),
    message: Schema.String,
    outcomeUnknown: Schema.Boolean,
    retryable: Schema.Boolean,
  }) {}

  export interface Interface {
    readonly deliver: (input: DeliveryInput) => Effect.Effect<Receipt, DeliveryError>;
    readonly indicateTyping: (input: TypingInput) => Effect.Effect<void, DeliveryError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/TelegramDelivery") {}

  export function layer(token: string): Layer.Layer<Service> {
    return Layer.sync(Service, () => {
      const api = new Api(token);
      const indicateTyping = Effect.fn("TelegramDelivery.indicateTyping")(function* indicateTyping(input) {
        yield* Effect.tryPromise({
          try: () =>
            api.sendChatAction(input.chatId, "typing", {
              message_thread_id: input.threadKey === 0 ? undefined : input.threadKey,
            }),
          catch: mapDeliveryError,
        });
      });
      const deliver = Effect.fn("TelegramDelivery.deliver")(function* deliver(input: DeliveryInput) {
        const { action } = input;
        if (action.type === "ignore") return { telegramMessageId: null };
        const startedAt = performance.now();

        return yield* Effect.tryPromise({
          try: async () => {
            if (action.type === "reaction") {
              await api.setMessageReaction(input.chatId, action.messageId, [{ emoji: action.emoji, type: "emoji" }]);
              return { telegramMessageId: null };
            }

            const sent = await api.sendMessage(input.chatId, action.text, {
              message_thread_id: input.threadKey === 0 ? undefined : input.threadKey,
              reply_parameters: action.replyTo ? { message_id: action.replyTo } : undefined,
            });
            return { telegramMessageId: sent.message_id };
          },
          catch: mapDeliveryError,
        }).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError((cause) =>
            cause instanceof DeliveryError
              ? cause
              : new DeliveryError({
                  cause,
                  message: "Telegram delivery outcome is unknown",
                  outcomeUnknown: true,
                  retryable: true,
                }),
          ),
          Effect.map((receipt) => {
            OperationalTelemetry.recordDuration("delivery", "delivered", performance.now() - startedAt);
            return receipt;
          }),
          Effect.tapError((error) => {
            OperationalTelemetry.recordDuration(
              "delivery",
              error.outcomeUnknown ? "unknown" : "failed",
              performance.now() - startedAt,
            );
            return Effect.void;
          }),
        );
      });

      return Service.of({ deliver, indicateTyping });
    });
  }

  function mapDeliveryError(cause: unknown): DeliveryError {
    if (cause instanceof GrammyError) {
      return new DeliveryError({
        cause,
        message: "Telegram rejected delivery",
        outcomeUnknown: false,
        retryable: cause.error_code === 429 || cause.error_code >= 500,
      });
    }

    return new DeliveryError({
      cause,
      message: "Telegram delivery outcome is unknown",
      outcomeUnknown: true,
      retryable: true,
    });
  }
}

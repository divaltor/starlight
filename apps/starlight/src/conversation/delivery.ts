import { Api, GrammyError } from "grammy";
import { Context, Duration, Effect, Layer, Schema } from "effect";

export interface IgnoreAction {
	readonly type: "ignore";
}

export interface ReactionAction {
	readonly emoji: string;
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
}

export class Service extends Context.Service<Service, Interface>()("starlight/TelegramDelivery") {}

export function layer(token: string): Layer.Layer<Service> {
	return Layer.sync(Service, () => {
		const api = new Api(token);
		const deliver = Effect.fn("TelegramDelivery.deliver")(function* deliver(input: DeliveryInput) {
			if (input.action.type === "ignore") return { telegramMessageId: null };

			return yield* Effect.tryPromise({
				try: async () => {
					if (input.action.type === "reaction") {
						await api.setMessageReaction(input.chatId, input.action.messageId, [
							{ emoji: input.action.emoji, type: "emoji" },
						]);
						return { telegramMessageId: null };
					}

					const sent = await api.sendMessage(input.chatId, input.action.text, {
						message_thread_id: input.threadKey === 0 ? undefined : input.threadKey,
						reply_parameters: input.action.replyTo
							? { message_id: input.action.replyTo }
							: undefined,
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
			);
		});

		return Service.of({ deliver });
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

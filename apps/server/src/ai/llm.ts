import env from "@starlight/utils/config";
import { APICallError, type LanguageModel } from "ai";
import { Effect, Schema } from "effect";
import { getLangfuseTelemetry } from "@/otel";
import { openrouter } from "@/utils/message";

export const Operation = Schema.Literals(["chat-memory", "message-reply"]);
export type Operation = typeof Operation.Type;

export interface TraceContext {
	readonly operation: Operation;
	readonly sessionId: string;
	readonly attributes: Readonly<Record<string, string>>;
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
	"LlmUnavailableError",
	{
		message: Schema.String,
	},
) {}

export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()("LlmProviderError", {
	operation: Operation,
	providerErrorName: Schema.String,
	message: Schema.String,
	statusCode: Schema.optional(Schema.Number),
	isRetryable: Schema.optional(Schema.Boolean),
	cause: Schema.optional(Schema.Defect),
}) {
	static fromApiCallError(operation: Operation, error: APICallError) {
		return new ProviderError({
			operation,
			providerErrorName: error.name,
			message: error.message,
			statusCode: error.statusCode,
			isRetryable: error.isRetryable,
			cause: Schema.Defect.make(error),
		});
	}
}

export class InvocationError extends Schema.TaggedErrorClass<InvocationError>()(
	"LlmInvocationError",
	{
		operation: Operation,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {
	static fromCause(operation: Operation, cause: unknown) {
		return new InvocationError({
			operation,
			message: cause instanceof Error ? cause.message : "LLM invocation failed",
			cause: Schema.Defect.make(cause),
		});
	}
}

export type Error = InvocationError | ProviderError | UnavailableError;

export function invoke<A>(
	trace: TraceContext,
	execute: (
		model: LanguageModel,
		generationOptions: ReturnType<typeof getLangfuseTelemetry>,
	) => Promise<A>,
): Effect.Effect<A, Error> {
	return Effect.gen(function* () {
		const provider = openrouter;

		if (!provider) {
			return yield* new UnavailableError({
				message: "OPENROUTER_API_KEY is not set",
			});
		}

		const runtimeContext = {
			...trace.attributes,
			sessionId: trace.sessionId,
		};

		return yield* Effect.tryPromise({
			try: () =>
				execute(
					provider(env.OPENROUTER_MODEL),
					getLangfuseTelemetry(trace.operation, runtimeContext),
				),
			catch: (cause) =>
				APICallError.isInstance(cause)
					? ProviderError.fromApiCallError(trace.operation, cause)
					: InvocationError.fromCause(trace.operation, cause),
		});
	}).pipe(Effect.withSpan(`Llm.${trace.operation}`));
}

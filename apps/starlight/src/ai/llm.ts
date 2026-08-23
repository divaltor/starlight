import env from "@starlight/utils/config";
import { APICallError } from "ai";
import type { LanguageModel } from "ai";
import { Effect, Schema } from "effect";
import { getLangfuseTelemetry } from "@/otel";
import { openrouter } from "@/utils/message";

export const Operation = Schema.Literals(["chat-memory", "message-reply"]);
export type Operation = typeof Operation.Type;

// Total deadline for one LLM call. Without it a stalled provider response never
// settles, which pins the runner update context (with its media) forever.
const LLM_TIMEOUT_MS = 120_000;

export interface TraceContext {
	readonly operation: Operation;
	readonly sessionId: string;
	readonly attributes: Readonly<Record<string, string>>;
}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
	"LlmUnavailableError",
	{
		message: Schema.String,
	},
) {}

export class ProviderError extends Schema.TaggedError<ProviderError>()("LlmProviderError", {
	operation: Operation,
	providerErrorName: Schema.String,
	message: Schema.String,
	statusCode: Schema.optional(Schema.Number),
	isRetryable: Schema.optional(Schema.Boolean),
	cause: Schema.optional(Schema.Defect()),
}) {
	static fromApiCallError(operation: Operation, error: APICallError) {
		return new ProviderError({
			operation,
			providerErrorName: error.name,
			message: error.message,
			statusCode: error.statusCode,
			isRetryable: error.isRetryable,
			cause: error,
		});
	}
}

export class InvocationError extends Schema.TaggedError<InvocationError>()("LlmInvocationError", {
	operation: Operation,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {
	static fromCause(operation: Operation, cause: unknown) {
		return new InvocationError({
			operation,
			message: cause instanceof Error ? cause.message : "LLM invocation failed",
			cause,
		});
	}
}

export type Error = InvocationError | ProviderError | UnavailableError;

export function invoke<A>(
	trace: TraceContext,
	execute: (
		model: LanguageModel,
		generationOptions: ReturnType<typeof getLangfuseTelemetry> & { timeout: number },
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
				execute(provider(env.OPENROUTER_MODEL), {
					...getLangfuseTelemetry(trace.operation, runtimeContext),
					timeout: LLM_TIMEOUT_MS,
				}),
			catch: (cause) =>
				APICallError.isInstance(cause)
					? ProviderError.fromApiCallError(trace.operation, cause)
					: InvocationError.fromCause(trace.operation, cause),
		});
	}).pipe(Effect.withSpan(`Llm.${trace.operation}`));
}

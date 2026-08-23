import {
  AISDKError,
  APICallError,
  generateText,
  isStepCount,
  NoOutputGeneratedError,
  Output,
  tool,
  TypeValidationError,
} from "ai";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import { Context, Duration, Effect, Layer, Option, Predicate, Schema } from "effect";
import type { ZodType } from "zod";
import { selected } from "@/ai/model-profile";
import * as ModelProvider from "@/ai/model-provider";
import * as ModelTelemetry from "@/ai/model-telemetry";
import { aggregateGenerationUsage, getUpstreamProvider, normalizeStepUsage } from "@/ai/usage";
import type { GenerationUsage, StepUsage } from "@/ai/usage";

const MODEL_TIMEOUT_MS = 120_000;

const errorFields = {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
  retryable: Schema.Boolean,
};

export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", errorFields) {}
export class ProviderRejected extends Schema.TaggedError<ProviderRejected>()("ProviderRejected", errorFields) {}
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", errorFields) {}
export class TimedOut extends Schema.TaggedError<TimedOut>()("TimedOut", errorFields) {}
export class InvalidOutput extends Schema.TaggedError<InvalidOutput>()("InvalidOutput", errorFields) {}
export class InvocationFailed extends Schema.TaggedError<InvocationFailed>()("InvocationFailed", errorFields) {}

export type Error = InvalidOutput | InvocationFailed | ProviderRejected | RateLimited | TimedOut | Unavailable;

export interface Message {
  readonly role: "assistant" | "user";
  readonly text: string;
}

export interface ToolInput {
  readonly [name: string]: string | undefined;
}

export interface ToolExecution {
  readonly signal?: AbortSignal;
}

export interface Tool {
  readonly description: string;
  readonly execute: (input: ToolInput, execution: ToolExecution) => Promise<object>;
  readonly inputSchema: ZodType<ToolInput>;
  readonly name: string;
}

export interface GenerateInput<OUTPUT> {
  readonly cacheBase?: string;
  readonly instructions: string;
  readonly maxOutputTokens?: number;
  readonly maxToolCalls: number;
  readonly messages: readonly Message[];
  readonly outputSchema: ZodType<OUTPUT>;
  // Rides on OpenRouter's body verbatim as prompt_cache_key for upstream cache routing.
  readonly promptCacheKey?: string;
  readonly sessionId: string;
  readonly tools: readonly Tool[];
}

export interface CompletedToolEvent {
  readonly durationMs: number;
  readonly input: object;
  readonly output: object;
  readonly state: "completed";
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface FailedToolEvent {
  readonly durationMs: number;
  readonly errorMessage: string;
  readonly errorName: string;
  readonly input: object;
  readonly state: "failed";
  readonly toolCallId: string;
  readonly toolName: string;
}

export type ToolEvent = CompletedToolEvent | FailedToolEvent;

export interface TranscriptEvent {
  readonly text: string;
  readonly type: "assistant-text";
}

export interface GenerationResult<OUTPUT> {
  readonly finishReason: string;
  readonly output: OUTPUT;
  readonly steps: readonly ModelStep[];
  readonly toolEvents: readonly ToolEvent[];
  readonly transcript: readonly TranscriptEvent[];
  readonly usage: GenerationUsage;
}

export interface ModelStep {
  readonly actualModel: string;
  readonly finishReason: string;
  readonly latencyMs: number;
  readonly providerRequestId: string;
  readonly stepNumber: number;
  readonly toolCallCount: number;
  readonly upstreamProvider: string | null;
  readonly usage: StepUsage;
}

export interface Interface {
  readonly generate: <OUTPUT>(input: GenerateInput<OUTPUT>) => Effect.Effect<GenerationResult<OUTPUT>, Error>;
}

export class Service extends Context.Service<Service, Interface>()("starlight/Model") {}

export const layer: Layer.Layer<Service, never, ModelProvider.Service | ModelTelemetry.Service> = Layer.effect(
  Service,
  Effect.gen(function* layer() {
    const provider = yield* ModelProvider.Service;
    const telemetry = yield* ModelTelemetry.Service;

    const generate = Effect.fn("Model.generate")(function* generate<OUTPUT>(input: GenerateInput<OUTPUT>) {
      if (Option.isNone(provider.model)) {
        return yield* new Unavailable({
          message: "OpenRouter configuration is unavailable",
          retryable: false,
        });
      }

      const completedSteps: StepResult<ToolSet>[] = [];
      const toolEvents: ToolEvent[] = [];
      const tools = createTools(input.tools);
      const invocation = Effect.tryPromise({
        try: async (signal) => {
          const result = await generateText({
            abortSignal: signal,
            headers: { "x-session-id": input.sessionId },
            instructions: input.instructions,
            maxOutputTokens: clampOutputTokens(input.maxOutputTokens),
            maxRetries: 0,
            messages: prepareMessages(input.cacheBase, input.messages),
            model: provider.model.value,
            onStepEnd: (step) => {
              completedSteps.push(step);
            },
            onToolExecutionEnd: (event) => {
              toolEvents.push(createToolEvent(event));
            },
            output: Output.object({ schema: input.outputSchema }),
            prepareStep: (step) => limitTools(step.steps, input.maxToolCalls),
            providerOptions: input.promptCacheKey
              ? { openrouter: { prompt_cache_key: input.promptCacheKey } }
              : undefined,
            stopWhen: isStepCount(Math.max(input.maxToolCalls, 0) + 1),
            telemetry: {
              functionId: "chat-reply",
              isEnabled: true,
              recordInputs: false,
              recordOutputs: false,
            },
            tools,
          });

          return { output: result.output, result };
        },
        catch: mapInvocationError,
      }).pipe(
        Effect.timeout(Duration.millis(MODEL_TIMEOUT_MS)),
        Effect.catchTag("TimeoutError", (cause) =>
          Effect.fail(
            new TimedOut({
              cause,
              message: "Model invocation timed out",
              retryable: true,
            }),
          ),
        ),
        Effect.tapError((error) => logFailure(error, completedSteps, toolEvents, telemetry)),
      );
      const generated = yield* invocation;
      // Dot notation is the project convention; destructuring is intentionally disabled.
      // oxlint-disable-next-line prefer-destructuring
      const result = generated.result;
      const stepUsage = result.steps.map((step) =>
        normalizeStepUsage(step.usage, step.providerMetadata, selected.prices),
      );

      yield* Effect.all(
        result.steps.map((step, index) =>
          Effect.sync(() => {
            recordStep(telemetry, step, stepUsage[index]!);
          }).pipe(
            Effect.andThen(
              Effect.logInfo("Model step completed").pipe(
                Effect.annotateLogs({
                  actualModel: step.response.modelId,
                  cacheReadTokens: stepUsage[index]?.cacheReadTokens ?? null,
                  cacheWriteTokens: stepUsage[index]?.cacheWriteTokens ?? null,
                  configuredModel: selected.model,
                  estimatedCostUsd: stepUsage[index]?.estimatedCostUsd ?? null,
                  finishReason: step.finishReason,
                  inputTokens: stepUsage[index]?.inputTokens ?? null,
                  latencyMs: step.performance.stepTimeMs,
                  outputTokens: stepUsage[index]?.outputTokens ?? null,
                  providerRequestId: step.response.id,
                  reasoningTokens: stepUsage[index]?.reasoningTokens ?? null,
                  reportedCostUsd: stepUsage[index]?.reportedCostUsd ?? null,
                  selectedCostUsd: stepUsage[index]?.selectedCostUsd ?? null,
                  stepIndex: step.stepNumber,
                  toolCallCount: step.toolCalls.length,
                  uncachedInputTokens: stepUsage[index]?.uncachedInputTokens ?? null,
                  upstreamProvider: getUpstreamProvider(step.providerMetadata),
                }),
              ),
            ),
          ),
        ),
      );

      if (stepUsage.some((usage) => usage.inputTokens === null)) {
        yield* Effect.logWarning("Model usage unavailable");
      }

      if ((result.warnings?.length ?? 0) > 0) {
        yield* Effect.logWarning("Model provider returned warnings").pipe(
          Effect.annotateLogs({ warningCount: result.warnings?.length ?? 0 }),
        );
      }

      const usage = aggregateGenerationUsage(stepUsage);
      telemetry.recordGeneration({ finishReason: result.finishReason, usage });

      yield* Effect.logInfo("Model generation completed").pipe(
        Effect.annotateLogs({
          billingCacheReadTokens: usage.billing.cacheReadTokens,
          billingCacheWriteTokens: usage.billing.cacheWriteTokens,
          billingCostUsd: usage.billing.costUsd,
          billingInputTokens: usage.billing.inputTokens,
          billingOutputTokens: usage.billing.outputTokens,
          billingReasoningTokens: usage.billing.reasoningTokens,
          configuredModel: selected.model,
          contextInputTokens: usage.contextInputTokens,
          finishReason: result.finishReason,
          stepCount: result.steps.length,
        }),
      );

      return {
        finishReason: result.finishReason,
        output: structuredClone(generated.output),
        steps: result.steps.map((step, index) => ({
          actualModel: step.response.modelId,
          finishReason: step.finishReason,
          latencyMs: step.performance.stepTimeMs,
          providerRequestId: step.response.id,
          stepNumber: step.stepNumber,
          toolCallCount: step.toolCalls.length,
          upstreamProvider: getUpstreamProvider(step.providerMetadata),
          usage: stepUsage[index]!,
        })),
        toolEvents: structuredClone(toolEvents),
        transcript: result.steps.flatMap((step) =>
          step.text ? [{ text: step.text, type: "assistant-text" as const }] : [],
        ),
        usage,
      };
    });

    return Service.of({ generate });
  }),
);

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(Layer.merge(ModelProvider.defaultLayer, ModelTelemetry.defaultLayer)),
);

function prepareMessages(cacheBase: string | undefined, messages: readonly Message[]): ModelMessage[] {
  const conversation = messages.map((message) => ({
    content: message.text,
    role: message.role,
  }));
  if (!cacheBase) return conversation;

  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: cacheBase,
          providerOptions: {
            openrouter: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
    },
    ...conversation,
  ];
}

function createTools(definitions: readonly Tool[]): ToolSet {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        execute: (input, options) => definition.execute(input, { signal: options.abortSignal }),
        inputSchema: definition.inputSchema,
      }),
    ]),
  );
}

function limitTools(steps: readonly StepResult<ToolSet>[], maximumCalls: number) {
  const callCount = steps.reduce((count, step) => count + step.toolCalls.length, 0);
  return callCount >= Math.max(maximumCalls, 0) ? { activeTools: [] } : undefined;
}

function clampOutputTokens(value: number | undefined): number {
  return Math.min(Math.max(value ?? selected.limits.defaultOutputTokens, 1), selected.limits.maximumOutputTokens);
}

function createToolEvent(event: {
  readonly toolExecutionMs: number;
  readonly toolOutput:
    | {
        readonly error: unknown;
        readonly input: unknown;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly type: "tool-error";
      }
    | {
        readonly input: unknown;
        readonly output: unknown;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly type: "tool-result";
      };
}): ToolEvent {
  const input = Predicate.isObject(event.toolOutput.input) ? structuredClone(event.toolOutput.input) : {};
  if (event.toolOutput.type === "tool-result") {
    return {
      durationMs: event.toolExecutionMs,
      input,
      output: Predicate.isObject(event.toolOutput.output) ? structuredClone(event.toolOutput.output) : {},
      state: "completed",
      toolCallId: event.toolOutput.toolCallId,
      toolName: event.toolOutput.toolName,
    };
  }

  const error = Predicate.isError(event.toolOutput.error)
    ? event.toolOutput.error
    : new globalThis.Error("Tool execution failed");

  return {
    durationMs: event.toolExecutionMs,
    errorMessage: error.message,
    errorName: error.name,
    input,
    state: "failed",
    toolCallId: event.toolOutput.toolCallId,
    toolName: event.toolOutput.toolName,
  };
}

function mapInvocationError(cause: unknown): Error {
  if (NoOutputGeneratedError.isInstance(cause) || TypeValidationError.isInstance(cause)) {
    return new InvalidOutput({
      cause,
      message: "Model output could not be decoded",
      retryable: true,
    });
  }

  if (APICallError.isInstance(cause) && cause.statusCode === 429) {
    return new RateLimited({
      cause,
      message: "Model provider rate limit exceeded",
      retryable: true,
    });
  }

  if (
    APICallError.isInstance(cause) &&
    cause.statusCode !== undefined &&
    cause.statusCode >= 400 &&
    cause.statusCode < 500
  ) {
    return new ProviderRejected({
      cause,
      message: "Model provider rejected the request",
      retryable: cause.isRetryable,
    });
  }

  return new InvocationFailed({
    cause,
    message: "Model invocation failed",
    retryable: APICallError.isInstance(cause) ? cause.isRetryable : AISDKError.isInstance(cause),
  });
}

function logFailure(
  error: Error,
  steps: readonly StepResult<ToolSet>[],
  toolEvents: readonly ToolEvent[],
  telemetry: ModelTelemetry.Interface,
) {
  const stepUsage = steps.map((step) => normalizeStepUsage(step.usage, step.providerMetadata, selected.prices));
  const usage = aggregateGenerationUsage(stepUsage);
  // Dot notation is the project convention; destructuring is intentionally disabled.
  // oxlint-disable-next-line prefer-destructuring
  const cause = error.cause;

  return Effect.all([
    ...steps.map((step, index) => Effect.sync(() => recordStep(telemetry, step, stepUsage[index]!))),
    Effect.sync(() =>
      telemetry.recordGeneration({
        errorTag: error._tag,
        finishReason: steps.at(-1)?.finishReason ?? "error",
        usage,
      }),
    ),
    Effect.logError("Model invocation failed").pipe(
      Effect.annotateLogs({
        billingCostUsd: usage.billing.costUsd,
        billingInputTokens: usage.billing.inputTokens,
        completedStepCount: steps.length,
        contextInputTokens: usage.contextInputTokens,
        errorTag: error._tag,
        providerErrorName: Predicate.isError(cause) ? cause.name : "UnknownError",
        retryable: error.retryable,
        statusCode: APICallError.isInstance(cause) ? cause.statusCode : undefined,
        toolEventCount: toolEvents.length,
      }),
    ),
  ]).pipe(Effect.asVoid);
}

function recordStep(telemetry: ModelTelemetry.Interface, step: StepResult<ToolSet>, usage: StepUsage): void {
  telemetry.recordStep({
    actualModel: step.response.modelId,
    finishReason: step.finishReason,
    latencyMs: step.performance.stepTimeMs,
    providerRequestId: step.response.id,
    stepIndex: step.stepNumber,
    toolCallCount: step.toolCalls.length,
    upstreamProvider: getUpstreamProvider(step.providerMetadata),
    usage,
  });
}

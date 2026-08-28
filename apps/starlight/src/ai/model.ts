import {
  AISDKError,
  APICallError,
  generateText,
  InvalidToolInputError,
  isStepCount,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  tool,
  TypeValidationError,
} from "ai";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import { Context, Duration, Effect, Layer, Predicate, Schema } from "effect";
import type { ZodType } from "zod";
import { selected } from "@/ai/model-profile";
import { ModelProvider } from "@/ai/model-provider";
import { Usage } from "@/ai/usage";
import type { Media } from "@/media/media";

export namespace Model {
  const MODEL_TIMEOUT_MS = 120_000;
  const MAX_GENERATION_STEPS = 32;
  const FINAL_OUTPUT_TOOL_NAME = "final_output";
  const FINAL_OUTPUT_INSTRUCTION =
    "IMPORTANT: You MUST use the final_output tool to provide your final response. Complete any necessary research first, then call final_output exactly once. Do not return the final response as text.";
  const FINAL_OUTPUT_TOOL_DESCRIPTION =
    "Return the complete final response in the required structured format. You must call this tool exactly once after completing any necessary research.";
  const INVOCATION_FAILED_MESSAGE = "Model invocation failed";
  const CACHE_BREAKPOINT_OPTIONS = { openrouter: { cacheControl: { type: "ephemeral" as const } } };

  const errorFields = {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    retryable: Schema.Boolean,
  };

  export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", errorFields) {}
  export class ProviderRejected extends Schema.TaggedError<ProviderRejected>()("ProviderRejected", errorFields) {}
  export class ContextOverflow extends Schema.TaggedError<ContextOverflow>()("ContextOverflow", errorFields) {}
  export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", errorFields) {}
  export class TimedOut extends Schema.TaggedError<TimedOut>()("TimedOut", errorFields) {}
  export class InvalidOutput extends Schema.TaggedError<InvalidOutput>()("InvalidOutput", errorFields) {}
  export class InvocationFailed extends Schema.TaggedError<InvocationFailed>()("InvocationFailed", errorFields) {}

  export type Error =
    | ContextOverflow
    | InvalidOutput
    | InvocationFailed
    | ProviderRejected
    | RateLimited
    | TimedOut
    | Unavailable;

  export interface Message {
    readonly media?: readonly Media.Loaded[];
    readonly role: "assistant" | "user";
    readonly text: string;
  }

  export interface GenerateInput<OUTPUT> {
    readonly cacheBase?: string;
    readonly cachePrefixMessageCount?: number;
    readonly instructions: string;
    readonly maxOutputTokens?: number;
    readonly maxToolOutputBytes: number;
    readonly maxToolSteps: number;
    readonly messages: readonly Message[];
    readonly outputSchema: ZodType<OUTPUT>;
    // Private chats keep cost/usage telemetry but never export input/output content.
    readonly private?: boolean;
    // Rides on OpenRouter's body verbatim as prompt_cache_key for upstream cache routing.
    readonly promptCacheKey?: string;
    readonly sessionId: string;
    readonly telemetryFunctionId?: string;
    readonly telemetryTraceName?: string;
    readonly telemetryUserId?: string;
    readonly tools: ToolSet;
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
    readonly usage: Usage.GenerationUsage;
  }

  export interface ModelStep {
    readonly actualModel: string;
    readonly finishReason: string;
    readonly latencyMs: number;
    readonly providerRequestId: string;
    readonly stepNumber: number;
    readonly toolCallCount: number;
    readonly upstreamProvider: string | null;
    readonly usage: Usage.StepUsage;
  }

  export interface Interface {
    readonly generate: <OUTPUT>(input: GenerateInput<OUTPUT>) => Effect.Effect<GenerationResult<OUTPUT>, Error>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Model") {}

  export const layer: Layer.Layer<Service, never, ModelProvider.Service> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const provider = yield* ModelProvider.Service;

      const generate = Effect.fn("Model.generate")(function* generate<OUTPUT>(input: GenerateInput<OUTPUT>) {
        const completedSteps: StepResult<ToolSet>[] = [];
        const toolEvents: ToolEvent[] = [];
        const outputs = new Map<string, OUTPUT>();
        const tools = {
          ...boundTools(input.tools, input.maxToolOutputBytes),
          [FINAL_OUTPUT_TOOL_NAME]: tool({
            description: FINAL_OUTPUT_TOOL_DESCRIPTION,
            execute: (output, execution) => {
              outputs.set(execution.toolCallId, output);
              return Promise.resolve({ captured: true });
            },
            inputSchema: input.outputSchema,
          }),
        };
        const invocation = Effect.tryPromise({
          try: (signal) =>
            generateText({
              abortSignal: signal,
              headers: { "x-session-id": input.sessionId },
              instructions: `${input.instructions}\n\n${FINAL_OUTPUT_INSTRUCTION}`,
              // Clamp the requested output budget into the configured provider limits.
              maxOutputTokens: Math.min(
                Math.max(input.maxOutputTokens ?? selected.limits.defaultOutputTokens, 1),
                selected.limits.maximumOutputTokens,
              ),
              maxRetries: 0,
              messages: prepareMessages(input.cacheBase, input.cachePrefixMessageCount ?? 0, input.messages),
              model: provider.model,
              onStepEnd: (step) => {
                completedSteps.push(step);
              },
              onToolExecutionEnd: (event) => {
                if (event.toolOutput.toolName === FINAL_OUTPUT_TOOL_NAME) return;
                toolEvents.push(createToolEvent(event));
              },
              prepareStep: (step) => limitToolSteps(step.steps, input.maxToolSteps),
              providerOptions: input.promptCacheKey
                ? { openrouter: { prompt_cache_key: input.promptCacheKey } }
                : undefined,
              runtimeContext: {
                "langfuse.session.id": input.sessionId,
                ...(input.private !== true &&
                  input.telemetryTraceName !== undefined && { "langfuse.trace.name": input.telemetryTraceName }),
                ...(input.telemetryUserId !== undefined && { "langfuse.user.id": input.telemetryUserId }),
                ...(input.private === true && { "starlight.private": true }),
              },
              stopWhen: [
                // A step whose only tool call is final_output means the answer is complete.
                (step) => {
                  const toolCalls = step.steps.at(-1)?.toolCalls;
                  return toolCalls?.length === 1 && toolCalls[0]?.toolName === FINAL_OUTPUT_TOOL_NAME;
                },
                isStepCount(MAX_GENERATION_STEPS),
              ],
              telemetry: {
                functionId: input.telemetryFunctionId ?? "chat-reply",
                isEnabled: true,
                recordInputs: input.private !== true,
                recordOutputs: input.private !== true,
              },
              toolChoice: "required",
              tools,
            }).then((result) => {
              const finalStep = result.steps.at(-1);
              const finalCall =
                finalStep?.toolCalls.length === 1 && finalStep.toolCalls[0]?.toolName === FINAL_OUTPUT_TOOL_NAME
                  ? finalStep.toolCalls[0]
                  : undefined;
              if (!finalCall || !outputs.has(finalCall.toolCallId)) {
                throw new NoOutputGeneratedError({ message: "Model did not produce exactly one final output" });
              }

              return { output: outputs.get(finalCall.toolCallId)!, result };
            }),
          catch: (cause) => mapInvocationError(cause, completedSteps.length === 0 && toolEvents.length === 0),
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
          Effect.tapError((error) => {
            // Dot notation is the project convention; destructuring is intentionally disabled.
            // oxlint-disable-next-line prefer-destructuring
            const cause = error.cause;
            const usage = Usage.aggregate(
              completedSteps.map((step) => Usage.normalizeStep(step.usage, step.providerMetadata)),
            );

            return Effect.logError(INVOCATION_FAILED_MESSAGE).pipe(
              Effect.annotateLogs({
                billingCostUsd: usage.billing.costUsd,
                billingInputTokens: usage.billing.inputTokens,
                completedStepCount: completedSteps.length,
                contextInputTokens: usage.contextInputTokens,
                errorTag: error._tag,
                providerErrorName: Predicate.isError(cause) ? cause.name : "UnknownError",
                retryable: error.retryable,
                statusCode: APICallError.isInstance(cause) ? cause.statusCode : undefined,
                toolEventCount: toolEvents.length,
              }),
            );
          }),
        );
        const generated = yield* invocation;
        // Dot notation is the project convention; destructuring is intentionally disabled.
        // oxlint-disable-next-line prefer-destructuring
        const result = generated.result;
        const stepUsage = result.steps.map((step) => Usage.normalizeStep(step.usage, step.providerMetadata));

        yield* Effect.all(
          result.steps.map((step, index) =>
            Effect.logInfo("Model step completed").pipe(
              Effect.annotateLogs({
                actualModel: step.response.modelId,
                cacheReadTokens: stepUsage[index]?.cacheReadTokens ?? null,
                cacheWriteTokens: stepUsage[index]?.cacheWriteTokens ?? null,
                configuredModel: selected.model,
                finishReason: step.finishReason,
                inputTokens: stepUsage[index]?.inputTokens ?? null,
                latencyMs: step.performance.stepTimeMs,
                outputTokens: stepUsage[index]?.outputTokens ?? null,
                providerRequestId: step.response.id,
                reasoningTokens: stepUsage[index]?.reasoningTokens ?? null,
                reportedCostUsd: stepUsage[index]?.reportedCostUsd ?? null,
                stepIndex: step.stepNumber,
                toolCallCount: step.toolCalls.length,
                uncachedInputTokens: stepUsage[index]?.uncachedInputTokens ?? null,
                upstreamProvider: Usage.upstreamProvider(step.providerMetadata),
              }),
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

        const usage = Usage.aggregate(stepUsage);

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
          output: generated.output,
          steps: result.steps.map((step, index) => ({
            actualModel: step.response.modelId,
            finishReason: step.finishReason,
            latencyMs: step.performance.stepTimeMs,
            providerRequestId: step.response.id,
            stepNumber: step.stepNumber,
            toolCallCount: step.toolCalls.length,
            upstreamProvider: Usage.upstreamProvider(step.providerMetadata),
            usage: stepUsage[index]!,
          })),
          toolEvents,
          transcript: result.steps.flatMap((step) =>
            step.text ? [{ text: step.text, type: "assistant-text" as const }] : [],
          ),
          usage,
        };
      });

      return Service.of({ generate });
    }),
  );

  export function defaultLayer(apiKey: string): Layer.Layer<Service> {
    return layer.pipe(Layer.provide(ModelProvider.defaultLayer(apiKey)));
  }

  function prepareMessages(
    cacheBase: string | undefined,
    cachePrefixMessageCount: number,
    messages: readonly Message[],
  ): ModelMessage[] {
    const conversation: ModelMessage[] = messages.map((message, index) => {
      const breakpoint = index === cachePrefixMessageCount - 1;
      if (message.role === "assistant" || !message.media?.length) {
        return {
          content: message.text,
          providerOptions: breakpoint ? CACHE_BREAKPOINT_OPTIONS : undefined,
          role: message.role,
        };
      }
      const content = [
        { text: message.text, type: "text" as const },
        ...message.media.map((item) =>
          item.mimeType.startsWith("image/")
            ? {
                image: item.bytes,
                mediaType: item.mimeType,
                type: "image" as const,
              }
            : {
                data: item.bytes,
                filename: `${item.sha256}.${
                  item.mimeType === "application/pdf"
                    ? "pdf"
                    : (item.mimeType.split("/").at(1)?.split(";").at(0) ?? "bin")
                }`,
                mediaType: item.mimeType,
                type: "file" as const,
              },
        ),
      ];
      return { content, providerOptions: breakpoint ? CACHE_BREAKPOINT_OPTIONS : undefined, role: message.role };
    });
    if (!cacheBase) return conversation;

    // OpenRouter's Vertex route does not provide reliable implicit caching for Gemini.
    // Advance one explicit breakpoint through the stable transcript instead.
    const base: ModelMessage =
      cachePrefixMessageCount === 0
        ? { content: cacheBase, providerOptions: CACHE_BREAKPOINT_OPTIONS, role: "user" }
        : { content: cacheBase, role: "user" };
    return [base, ...conversation];
  }

  function boundTools(tools: ToolSet, maximumBytes: number): ToolSet {
    let remainingBytes = Math.max(0, maximumBytes);
    return Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const { execute } = definition;
        if (!execute) return [name, definition];
        return [
          name,
          {
            ...definition,
            execute: async (...parameters: Parameters<typeof execute>) => {
              const output = await execute(...parameters);
              const serialized = JSON.stringify(output) ?? String(output);
              const encoded = new TextEncoder().encode(serialized);
              if (encoded.byteLength <= remainingBytes) {
                remainingBytes -= encoded.byteLength;
                return output;
              }

              const bounded = boundToolOutput(serialized, encoded, remainingBytes);
              remainingBytes = Math.max(
                0,
                remainingBytes - new TextEncoder().encode(JSON.stringify(bounded)).byteLength,
              );
              return bounded;
            },
          },
        ];
      }),
    );
  }

  function boundToolOutput(serialized: string, encoded: Uint8Array, maximumBytes: number) {
    const metadata = {
      originalBytes: encoded.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(serialized).digest("hex"),
      truncated: true as const,
    };
    const encode = (preview: string) => ({
      bytes: new TextEncoder().encode(JSON.stringify({ preview, truncation: metadata })).byteLength,
      output: { preview, truncation: metadata },
    });
    if (encode("").bytes > maximumBytes) {
      const marker = { truncated: true as const };
      return new TextEncoder().encode(JSON.stringify(marker)).byteLength <= maximumBytes ? marker : {};
    }

    let lower = 0;
    let upper = encoded.byteLength;
    let bounded = encode("");
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const candidate = encode(new TextDecoder().decode(encoded.slice(0, middle)));
      if (candidate.bytes <= maximumBytes) {
        bounded = candidate;
        lower = middle + 1;
        continue;
      }
      upper = middle - 1;
    }
    return bounded.output;
  }

  function limitToolSteps(steps: readonly StepResult<ToolSet>[], maximumSteps: number) {
    // Once the tool-step budget is spent, only final_output stays active so the model must answer.
    const toolStepCount = steps.filter((step) =>
      step.toolCalls.some((toolCall) => toolCall.toolName !== FINAL_OUTPUT_TOOL_NAME),
    ).length;
    return toolStepCount >= Math.max(maximumSteps, 0) ? { activeTools: [FINAL_OUTPUT_TOOL_NAME] as const } : undefined;
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

  function mapInvocationError(cause: unknown, beforeOutput: boolean): Error {
    if (
      InvalidToolInputError.isInstance(cause) ||
      NoObjectGeneratedError.isInstance(cause) ||
      NoOutputGeneratedError.isInstance(cause) ||
      TypeValidationError.isInstance(cause)
    ) {
      return new InvalidOutput({
        cause,
        message: "Model output could not be decoded",
        retryable: true,
      });
    }

    if (!APICallError.isInstance(cause)) {
      return new InvocationFailed({
        cause,
        message: INVOCATION_FAILED_MESSAGE,
        retryable: AISDKError.isInstance(cause),
      });
    }

    if (
      beforeOutput &&
      (cause.statusCode === 400 || cause.statusCode === 413) &&
      /context(?: length| window)|input.*too long|prompt.*too long|too many tokens|token limit exceeded/iu.test(
        `${cause.message}\n${cause.responseBody ?? ""}`,
      )
    ) {
      return new ContextOverflow({
        cause,
        message: "Model context limit exceeded",
        retryable: false,
      });
    }

    if (cause.statusCode === 429) {
      return new RateLimited({
        cause,
        message: "Model provider rate limit exceeded",
        retryable: true,
      });
    }

    if (cause.statusCode !== undefined && cause.statusCode >= 400 && cause.statusCode < 500) {
      return new ProviderRejected({
        cause,
        message: "Model provider rejected the request",
        retryable: cause.isRetryable,
      });
    }

    return new InvocationFailed({
      cause,
      message: INVOCATION_FAILED_MESSAGE,
      retryable: cause.isRetryable,
    });
  }
}

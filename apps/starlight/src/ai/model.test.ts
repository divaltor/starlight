import { expect, test } from "bun:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { LanguageModel, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { ConfigProvider, Effect, Fiber, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { z } from "zod";
import * as Model from "@/ai/model";
import * as ModelProvider from "@/ai/model-provider";
import * as ModelTelemetry from "@/ai/model-telemetry";

test.each([{}, { OPENROUTER_API_KEY: "   " }])(
  "returns Unavailable without usable provider configuration",
  async (configuration) => {
    const program = Effect.gen(function* () {
      const model = yield* Model.Service;
      return yield* model.generate({
        instructions: "test",
        maxToolCalls: 0,
        messages: [{ role: "user", text: "test" }],
        outputSchema: z.string(),
        sessionId: "model-test",
        tools: {},
      });
    });
    const error = await Effect.runPromise(
      program.pipe(
        Effect.flip,
        Effect.provide(Model.defaultLayer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(configuration)),
      ),
    );

    expect(error._tag).toBe("Unavailable");
    expect(error.retryable).toBe(false);
  },
);

test("returns an immutable completed tool event", async () => {
  const toolOutput = { value: "before" };
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), textResult('{"answer":"done"}')],
    }),
    {
      maxToolCalls: 1,
      outputSchema: z.object({ answer: z.string() }),
      tools: {
        web_lookup: {
          description: "Return a fixture",
          execute: () => Promise.resolve(toolOutput),
          inputSchema: z.object({ query: z.string() }),
        },
      },
    },
  );
  toolOutput.value = "after";

  expect(result.toolEvents).toEqual([
    {
      durationMs: expect.any(Number),
      input: { query: "current fact" },
      output: { value: "before" },
      state: "completed",
      toolCallId: "call-1",
      toolName: "web_lookup",
    },
  ]);
});

test("returns a failed tool event when generation recovers", async () => {
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), textResult('{"answer":"recovered"}')],
    }),
    {
      maxToolCalls: 1,
      outputSchema: z.object({ answer: z.string() }),
      tools: {
        web_lookup: {
          description: "Fail with a fixture error",
          execute: () => Promise.reject(new Error("fixture failure")),
          inputSchema: z.object({ query: z.string() }),
        },
      },
    },
  );

  expect(result.output).toEqual({ answer: "recovered" });
  expect(result.toolEvents).toEqual([
    {
      durationMs: expect.any(Number),
      errorMessage: "fixture failure",
      errorName: "Error",
      input: { query: "current fact" },
      state: "failed",
      toolCallId: "call-1",
      toolName: "web_lookup",
    },
  ]);
});

test("executes at most one tool call", async () => {
  let executionCount = 0;
  const error = await runModelEffect(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), toolCallResult("call-2")],
    }),
    {
      maxToolCalls: 1,
      outputSchema: z.object({ answer: z.string() }),
      tools: {
        web_lookup: {
          description: "Count executions",
          execute: (input) => {
            executionCount += 1;
            return Promise.resolve(input);
          },
          inputSchema: z.object({ query: z.string() }),
        },
      },
    },
  ).pipe(Effect.flip, Effect.runPromise);

  expect(error._tag).toBe("InvalidOutput");
  expect(executionCount).toBe(1);
});

test("does not put prompt or tool-result content in model logs", async () => {
  const logs: { annotations: object; message: unknown }[] = [];
  const collector = Logger.formatStructured.pipe(
    Logger.map((output) => logs.push({ annotations: output.annotations, message: output.message })),
  );
  const result = await runModelEffect(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), textResult('{"answer":"done"}')],
    }),
    {
      instructions: "TOP_SECRET_PROMPT",
      maxToolCalls: 1,
      messages: [{ role: "user", text: "TOP_SECRET_MESSAGE" }],
      outputSchema: z.object({ answer: z.string() }),
      tools: {
        web_lookup: {
          description: "Return sensitive fixture content",
          execute: () => Promise.resolve({ value: "TOP_SECRET_TOOL_RESULT" }),
          inputSchema: z.object({ query: z.string() }),
        },
      },
    },
  ).pipe(Effect.provide(Logger.layer([collector])), Effect.runPromise);
  const serializedLogs = JSON.stringify(logs);

  expect(result.output).toEqual({ answer: "done" });
  expect(serializedLogs).toContain("Model generation completed");
  expect(logs.find((entry) => entry.message === "Model generation completed")?.annotations).toMatchObject({
    billingInputTokens: 20,
    stepCount: 2,
  });
  expect(serializedLogs).not.toContain("TOP_SECRET_PROMPT");
  expect(serializedLogs).not.toContain("TOP_SECRET_MESSAGE");
  expect(serializedLogs).not.toContain("TOP_SECRET_TOOL_RESULT");
});

test("aborts provider work and returns TimedOut at the total deadline", async () => {
  let aborted = false;
  let failedGeneration: ModelTelemetry.GenerationInput | undefined;
  const model = new MockLanguageModelV3({
    doGenerate: ({ abortSignal }) => {
      const pending = Promise.withResolvers<never>();
      abortSignal?.addEventListener("abort", () => {
        aborted = true;
        pending.reject(new Error("provider request aborted"));
      });
      return pending.promise;
    },
  });
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runModelEffect(
          model,
          { outputSchema: z.object({ answer: z.string() }) },
          Layer.succeed(ModelTelemetry.Service)(
            ModelTelemetry.Service.of({
              recordGeneration: (input) => {
                failedGeneration = input;
              },
              recordStep: () => {},
            }),
          ),
        ).pipe(Effect.flip),
      );
      yield* TestClock.adjust("120 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect(error._tag).toBe("TimedOut");
  expect(aborted).toBe(true);
  expect(failedGeneration?.usage.billing.costUsd).toBeNull();
  expect(failedGeneration?.usage.validForCostThresholds).toBe(false);
});

test("aborts an active tool when the total deadline expires", async () => {
  let toolAborted = false;
  const pending = Promise.withResolvers<object>();
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runModelEffect(new MockLanguageModelV3({ doGenerate: toolCallResult("call-1") }), {
          maxToolCalls: 1,
          outputSchema: z.object({ answer: z.string() }),
          tools: {
            web_lookup: {
              description: "Wait until cancellation",
              execute: (_input, execution) => {
                execution.abortSignal?.addEventListener("abort", () => {
                  toolAborted = true;
                  pending.reject(new Error("tool aborted"));
                });
                return pending.promise;
              },
              inputSchema: z.object({ query: z.string() }),
            },
          },
        }).pipe(Effect.flip),
      );
      yield* TestClock.adjust("120 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect(error._tag).toBe("TimedOut");
  expect(toolAborted).toBe(true);
});

test("exports safe normalized step and billing trace fields", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const result = await runModel(
    new MockLanguageModelV3({ doGenerate: textResult('{"answer":"TRACE_SECRET_OUTPUT"}') }),
    {
      instructions: "TRACE_SECRET_INSTRUCTIONS",
      messages: [{ role: "user", text: "TRACE_SECRET_MESSAGE" }],
      outputSchema: z.object({ answer: z.string() }),
    },
    ModelTelemetry.fromTracer(provider.getTracer("model-test")),
  );
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  await provider.shutdown();

  expect(result.output).toEqual({ answer: "TRACE_SECRET_OUTPUT" });
  expect(spans.find((span) => span.name === "Model step")?.attributes).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "google/gemini-3.7-flash",
    "gen_ai.response.model": "mock-model",
    "starlight.model.actual": "mock-model",
    "starlight.model.cache.result": "confirmed-miss",
    "starlight.model.configured": "google/gemini-3.7-flash",
    "starlight.model.tokens.input": 10,
    "starlight.model.tokens.output": 5,
  });
  expect(spans.find((span) => span.name === "Model generation")?.attributes).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "google/gemini-3.7-flash",
    "starlight.model.billing.input_tokens": 10,
    "starlight.model.billing.output_tokens": 5,
    "starlight.model.step_count": 1,
  });
  const serializedSpans = JSON.stringify(spans.map((span) => ({ attributes: span.attributes, name: span.name })));
  expect(serializedSpans).not.toContain("TRACE_SECRET_INSTRUCTIONS");
  expect(serializedSpans).not.toContain("TRACE_SECRET_MESSAGE");
  expect(serializedSpans).not.toContain("TRACE_SECRET_OUTPUT");
});

interface ModelTestInput<OUTPUT> {
  readonly instructions?: string;
  readonly maxToolCalls?: number;
  readonly messages?: readonly Model.Message[];
  readonly outputSchema: z.ZodType<OUTPUT>;
  readonly tools?: ToolSet;
}

function runModel<OUTPUT>(
  model: LanguageModel,
  input: ModelTestInput<OUTPUT>,
  telemetry = ModelTelemetry.defaultLayer,
) {
  return runModelEffect(model, input, telemetry).pipe(Effect.runPromise);
}

function runModelEffect<OUTPUT>(
  model: LanguageModel,
  input: ModelTestInput<OUTPUT>,
  telemetry = ModelTelemetry.defaultLayer,
) {
  return Effect.gen(function* () {
    const service = yield* Model.Service;
    return yield* service.generate({
      instructions: input.instructions ?? "fixture instructions",
      maxToolCalls: input.maxToolCalls ?? 0,
      messages: input.messages ?? [{ role: "user", text: "fixture message" }],
      outputSchema: input.outputSchema,
      sessionId: "model-test",
      tools: input.tools ?? {},
    });
  }).pipe(Effect.provide(Model.layer.pipe(Layer.provide(Layer.merge(ModelProvider.testLayer(model), telemetry)))));
}

function textResult(text: string) {
  return {
    content: [{ text, type: "text" as const }],
    finishReason: { raw: "stop", unified: "stop" as const },
    response: { id: "response-1", modelId: "mock-model" },
    usage: modelUsage,
    warnings: [],
  };
}

function toolCallResult(toolCallId: string) {
  return {
    content: [
      {
        input: '{"query":"current fact"}',
        toolCallId,
        toolName: "web_lookup",
        type: "tool-call" as const,
      },
    ],
    finishReason: { raw: "tool-calls", unified: "tool-calls" as const },
    response: { id: `response-${toolCallId}`, modelId: "mock-model" },
    usage: modelUsage,
    warnings: [],
  };
}

const modelUsage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 5, total: 5 },
};

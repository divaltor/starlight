import { expect, test } from "bun:test";
import { APICallError } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Effect, Fiber, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { z } from "zod";
import { Model } from "@/ai/model";
import { ModelProfile } from "@/ai/model-profile";
import { ModelProvider } from "@/ai/model-provider";

test("returns an immutable completed tool event", async () => {
  const toolOutput = { value: "before" };
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), finalOutputResult("done")],
    }),
    {
      maxToolSteps: 1,
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

test("bounds cumulative tool output before another model step", async () => {
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), finalOutputResult("done")],
    }),
    {
      maxToolOutputBytes: 200,
      maxToolSteps: 1,
      outputSchema: z.object({ answer: z.string() }),
      tools: {
        web_lookup: {
          description: "Return a large fixture",
          execute: () => Promise.resolve({ value: "x".repeat(1000) }),
          inputSchema: z.object({ query: z.string() }),
        },
      },
    },
  );

  const { output } = result.toolEvents[0] as Model.CompletedToolEvent;
  expect(output).toMatchObject({
    truncation: { originalBytes: 1012, truncated: true },
  });
  expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThanOrEqual(200);
});

test("returns a failed tool event when generation recovers", async () => {
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), finalOutputResult("recovered")],
    }),
    {
      maxToolSteps: 1,
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

test("returns schema output after research without recording its JSON carrier", async () => {
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), textResult('{"answer":"fresh"}')],
    }),
    {
      maxToolSteps: 1,
      outputSchema: z.object({ answer: z.string() }),
      profile: {
        ...ModelProfile.profiles["google/gemini-3-flash-preview"],
        output: { protocol: ModelProfile.outputProtocols.jsonSchemaResponse },
      },
      tools: {
        web_lookup: {
          description: "Return a fixture",
          execute: () => Promise.resolve({ value: "fresh fact" }),
          inputSchema: z.object({ query: z.string() }),
        },
      },
    },
  );

  expect(result.output).toEqual({ answer: "fresh" });
  expect(result.toolEvents).toHaveLength(1);
  expect(result.transcript).toEqual([]);
});

test("requires final output after at most three external tool steps", async () => {
  let executionCount = 0;
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [
        parallelToolCallResult("call-1", "call-2"),
        parallelToolCallResult("call-3", "call-4"),
        parallelToolCallResult("call-5", "call-6"),
        finalOutputResult("done"),
      ],
    }),
    {
      maxToolSteps: 3,
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
  );

  expect(result.output).toEqual({ answer: "done" });
  expect(executionCount).toBe(6);
});

test("waits for external tool results before accepting final output", async () => {
  const result = await runModel(
    new MockLanguageModelV3({
      doGenerate: [
        {
          content: [
            {
              input: '{"query":"current fact"}',
              toolCallId: "web-call",
              toolName: "web_lookup",
              type: "tool-call" as const,
            },
            {
              input: '{"answer":"stale"}',
              toolCallId: "mixed-final-call",
              toolName: "final_output",
              type: "tool-call" as const,
            },
          ],
          finishReason: { raw: "tool-calls", unified: "tool-calls" as const },
          response: { id: "mixed-response", modelId: "mock-model" },
          usage: modelUsage,
          warnings: [],
        },
        finalOutputResult("fresh"),
      ],
    }),
    {
      maxToolSteps: 1,
      outputSchema: z.object({ answer: z.string() }),
      tools: {
        web_lookup: {
          description: "Return a fixture",
          execute: () => Promise.resolve({ value: "fresh fact" }),
          inputSchema: z.object({ query: z.string() }),
        },
      },
    },
  );

  expect(result.output).toEqual({ answer: "fresh" });
});

test("rejects malformed final output tool input", async () => {
  const error = await runModelEffect(new MockLanguageModelV3({ doGenerate: finalOutputResult(42) }), {
    outputSchema: z.object({ answer: z.string() }),
  }).pipe(Effect.flip, Effect.runPromise);

  expect(error._tag).toBe("InvalidOutput");
});

test("stops after 32 model steps", async () => {
  let executionCount = 0;
  let callCount = 0;
  const error = await runModelEffect(
    new MockLanguageModelV3({
      doGenerate: () => {
        callCount += 1;
        return Promise.resolve(toolCallResult(`call-${callCount}`));
      },
    }),
    {
      maxToolSteps: 100,
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
  expect(executionCount).toBe(32);
});

test("does not put prompt or tool-result content in model logs", async () => {
  const logs: { annotations: object; message: unknown }[] = [];
  const collector = Logger.formatStructured.pipe(
    Logger.map((output) => logs.push({ annotations: output.annotations, message: output.message })),
  );
  const result = await runModelEffect(
    new MockLanguageModelV3({
      doGenerate: [toolCallResult("call-1"), finalOutputResult("done")],
    }),
    {
      instructions: "TOP_SECRET_PROMPT",
      maxToolSteps: 1,
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

test("classifies a provider context rejection before output", async () => {
  const error = await runModelEffect(
    new MockLanguageModelV3({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            isRetryable: false,
            message: "Prompt exceeds the context window",
            requestBodyValues: {},
            statusCode: 400,
            url: "https://provider.invalid/generate",
          }),
        ),
    }),
    { outputSchema: z.object({ answer: z.string() }) },
  ).pipe(Effect.flip, Effect.runPromise);

  expect(error._tag).toBe("ContextOverflow");
  expect(error.retryable).toBe(false);
});

test("aborts provider work and returns TimedOut at the total deadline", async () => {
  let aborted = false;
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
        runModelEffect(model, { outputSchema: z.object({ answer: z.string() }) }).pipe(Effect.flip),
      );
      yield* TestClock.adjust("120 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect(error._tag).toBe("TimedOut");
  expect(aborted).toBe(true);
});

test("aborts an active tool when the total deadline expires", async () => {
  let toolAborted = false;
  const pending = Promise.withResolvers<object>();
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runModelEffect(new MockLanguageModelV3({ doGenerate: toolCallResult("call-1") }), {
          maxToolSteps: 1,
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

interface ModelTestInput<OUTPUT> {
  readonly instructions?: string;
  readonly maxToolOutputBytes?: number;
  readonly maxToolSteps?: number;
  readonly messages?: readonly Model.Message[];
  readonly outputSchema: z.ZodType<OUTPUT>;
  readonly profile?: ModelProfile.Profile;
  readonly tools?: ToolSet;
}

function runModel<OUTPUT>(model: LanguageModel, input: ModelTestInput<OUTPUT>) {
  return runModelEffect(model, input).pipe(Effect.runPromise);
}

function runModelEffect<OUTPUT>(model: LanguageModel, input: ModelTestInput<OUTPUT>) {
  return Effect.gen(function* () {
    const service = yield* Model.Service;
    return yield* service.generate({
      instructions: input.instructions ?? "fixture instructions",
      maxToolOutputBytes: input.maxToolOutputBytes ?? 16 * 1024,
      maxToolSteps: input.maxToolSteps ?? 0,
      messages: input.messages ?? [{ role: "user", text: "fixture message" }],
      outputSchema: input.outputSchema,
      sessionId: "model-test",
      tools: input.tools ?? {},
    });
  }).pipe(
    Effect.provide(
      Model.layer.pipe(
        Layer.provide(
          Layer.succeed(ModelProvider.Service)({
            model,
            profile: input.profile ?? ModelProfile.profiles["google/gemini-3.7-flash"],
          }),
        ),
      ),
    ),
  );
}

function textResult(text: string) {
  return {
    content: [{ text, type: "text" as const }],
    finishReason: { raw: "stop", unified: "stop" as const },
    response: { id: "text-response", modelId: "mock-model" },
    usage: modelUsage,
    warnings: [],
  };
}

function finalOutputResult(answer: string | number) {
  return {
    content: [
      {
        input: JSON.stringify({ answer }),
        toolCallId: "final-output-call",
        toolName: "final_output",
        type: "tool-call" as const,
      },
    ],
    finishReason: { raw: "tool-calls", unified: "tool-calls" as const },
    response: { id: "final-output-response", modelId: "mock-model" },
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

function parallelToolCallResult(firstToolCallId: string, secondToolCallId: string) {
  return {
    content: [
      {
        input: '{"query":"current fact"}',
        toolCallId: firstToolCallId,
        toolName: "web_lookup",
        type: "tool-call" as const,
      },
      {
        input: '{"query":"current fact"}',
        toolCallId: secondToolCallId,
        toolName: "web_lookup",
        type: "tool-call" as const,
      },
    ],
    finishReason: { raw: "tool-calls", unified: "tool-calls" as const },
    response: { id: `response-${firstToolCallId}`, modelId: "mock-model" },
    usage: modelUsage,
    warnings: [],
  };
}

const modelUsage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 5, total: 5 },
};

import { expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Effect, Layer } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import { Model } from "@/ai/model";
import { ModelProvider } from "@/ai/model-provider";

test("caps a chatbot reply at 4,096 provider output tokens", async () => {
  const model = replyModel();
  await runReply(model);

  expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(4096);
});

function modelLayer(model: LanguageModel) {
  return Model.layer.pipe(Layer.provide(Layer.succeed(ModelProvider.Service)({ model })));
}

function replyModel() {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          input: '{"replies":[{"type":"ignore"}]}',
          toolCallId: "final-output-call",
          toolName: "final_output",
          type: "tool-call",
        },
      ],
      finishReason: { raw: "tool-calls", unified: "tool-calls" },
      response: { id: "response-1", modelId: "mock-model" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
        outputTokens: { reasoning: 0, text: 5, total: 5 },
      },
      warnings: [],
    },
  });
}

function runReply(model: LanguageModel) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const chatReply = yield* ChatReply.Service;
      return yield* chatReply.generate({
        messages: [{ role: "user", text: "LIVE MESSAGE #1: привет" }],
        sessionId: "chat-reply-test",
        toolset: { profile: [], tools: {} },
      });
    }).pipe(Effect.provide(ChatReply.layer.pipe(Layer.provide(modelLayer(model))))),
  );
}

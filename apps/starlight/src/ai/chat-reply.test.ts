import { expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Effect, Layer } from "effect";
import * as ChatReply from "@/ai/chat-reply";
import * as Model from "@/ai/model";
import * as ModelProvider from "@/ai/model-provider";
import * as ModelTelemetry from "@/ai/model-telemetry";
import * as Exa from "@/services/exa";

test("caps a chatbot reply at 1,024 provider output tokens", async () => {
  const model = textModel('{"replies":[{"type":"ignore"}]}');
  await runReply(model);

  expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(1024);
});

function modelLayer(model: LanguageModel) {
  return Model.layer.pipe(Layer.provide(Layer.merge(ModelProvider.testLayer(model), ModelTelemetry.defaultLayer)));
}

function textModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ text, type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
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
    ChatReply.generate({
      messages: [{ role: "user", text: "LIVE MESSAGE #1: привет" }],
      sessionId: "chat-reply-test",
    }).pipe(Effect.provideService(Exa.Service, disabledExa), Effect.provide(modelLayer(model))),
  );
}

const disabledExa: Exa.Interface = {
  isEnabled: () => false,
  tools: {},
};

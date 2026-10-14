import { expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Effect, Layer } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import { Model } from "@/ai/model";
import { ModelProfile } from "@/ai/model-profile";
import { ModelProvider } from "@/ai/model-provider";

test("caps a chatbot reply at 4,096 provider output tokens", async () => {
  const model = replyModel();
  await runReply(model);

  expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(4096);
});

test("uses Gemini-compatible enum discriminators for JSON schema replies", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ text: '{"replies":[{"text":"hi","type":"text"}]}', type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      response: { id: "response-1", modelId: "mock-model" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
        outputTokens: { reasoning: 0, text: 5, total: 5 },
      },
      warnings: [],
    },
  });

  await runReply(model, {
    ...ModelProfile.profiles["google/gemini-3-flash-preview"],
    output: { protocol: ModelProfile.outputProtocols.jsonSchemaResponse },
  });

  expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({
    schema: {
      properties: {
        replies: {
          items: {
            anyOf: [
              { properties: { type: { enum: ["ignore"] } } },
              { properties: { type: { enum: ["text"] } } },
              { properties: { type: { enum: ["reaction"] } } },
            ],
          },
        },
      },
    },
    type: "json",
  });
  expect(JSON.stringify(model.doGenerateCalls[0]?.responseFormat)).not.toContain('"const"');
});

test.each([
  { private: true, count: 5, accepted: true },
  { private: true, count: 6, accepted: false },
  { private: false, count: 3, accepted: true },
  { private: false, count: 4, accepted: false },
])("test_reply_limit_when_private_$private_and_count_$count", async (input) => {
  const replies = Array.from({ length: input.count }, (_, index) => ({
    type: "text" as const,
    text: `Part ${index + 1}`,
  }));

  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ text: JSON.stringify({ replies }), type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      response: { id: "response-1", modelId: "mock-model" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
        outputTokens: { reasoning: 0, text: 5, total: 5 },
      },
      warnings: [],
    },
  });

  const result = runReply(
    model,
    {
      ...ModelProfile.profiles["google/gemini-3-flash-preview"],
      output: { protocol: ModelProfile.outputProtocols.jsonSchemaResponse },
    },
    { private: input.private },
  );

  if (!input.accepted) {
    try {
      await result;
      expect.unreachable("Replies exceeding the chat limit must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Model.InvalidOutput);
    }

    return;
  }

  const generated = await result;
  expect(generated.output.replies).toEqual(replies);
});

function modelLayer(
  model: LanguageModel,
  profile: ModelProfile.Profile = ModelProfile.profiles["google/gemini-3-flash-preview"],
) {
  return Model.layer.pipe(Layer.provide(Layer.succeed(ModelProvider.Service)({ model, profile })));
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

async function runReply(
  model: LanguageModel,
  profile: ModelProfile.Profile = ModelProfile.profiles["google/gemini-3-flash-preview"],
  options: Pick<ChatReply.GenerateInput, "private"> = {},
) {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const chatReply = yield* ChatReply.Service;

      return yield* chatReply.generate({
        messages: [{ role: "user", text: "LIVE MESSAGE #1: привет" }],
        private: options.private,
        sessionId: "chat-reply-test",
        toolset: { profile: [], tools: {} },
      });
    }).pipe(Effect.provide(ChatReply.layer.pipe(Layer.provide(modelLayer(model, profile))))),
  );
}

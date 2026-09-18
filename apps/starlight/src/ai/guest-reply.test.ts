import { expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import type { ChatTools } from "@/ai/chat-tools";
import { GuestReply } from "@/ai/guest-reply";
import { Model } from "@/ai/model";
import { ModelProfile } from "@/ai/model-profile";
import { ModelProvider } from "@/ai/model-provider";

// Our product must offer resolved chat tools to guest generation because a guest
// asking about a link or current fact otherwise gets an answer without research.

test("test_guest_reply_offers_resolved_tool_alongside_final_output", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: [toolCallResult("call-1"), finalOutputResult("researched")],
  });
  const text = await runGuest(model, {
    profile: [],
    tools: {
      web_lookup: {
        description: "Return a fixture",
        execute: () => Promise.resolve({ value: "fresh fact" }),
        inputSchema: z.object({ query: z.string() }),
      },
    },
  });

  expect(text).toBe("researched");
  expect(offeredTools(model)[0]).toEqual(["final_output", "web_lookup"]);
});

test("test_guest_reply_offers_only_final_output_when_toolset_empty", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: [finalOutputResult("direct")],
  });
  const text = await runGuest(model, { profile: [], tools: {} });

  expect(text).toBe("direct");
  expect(offeredTools(model)).toEqual([["final_output"]]);
});

test("test_guest_reply_separates_generated_paragraphs_with_blank_lines", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: [finalOutputResult("first point", "second point")],
  });

  expect(await runGuest(model, { profile: [], tools: {} })).toBe("first point\n\nsecond point");
});

test("test_guest_reply_returns_only_the_clarification_question_when_context_is_missing", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: [finalClarificationResult("what should I evaluate?")],
  });

  expect(await runGuest(model, { profile: [], tools: {} })).toBe("what should I evaluate?");
});

test("test_guest_reply_appends_an_exceptional_decision_question_to_the_last_paragraph", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: [finalOutputResultWithFollowUp("both work", "do you value comfort or durability more?")],
  });

  expect(await runGuest(model, { profile: [], tools: {} })).toBe("both work do you value comfort or durability more?");
});

function runGuest(model: LanguageModel, toolset: ChatTools.Resolved) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const guestReply = yield* GuestReply.Service;
      return yield* guestReply.generate({
        message: "what is this link?",
        repliedMedia: [],
        repliedMessage: null,
        sessionId: "guest-reply-test",
        toolset,
      });
    }).pipe(
      Effect.provide(
        GuestReply.layer.pipe(
          Layer.provide(
            Model.layer.pipe(
              Layer.provide(
                Layer.succeed(ModelProvider.Service)({
                  model,
                  profile: ModelProfile.profiles["google/gemini-3.7-flash"],
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
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

function finalOutputResult(...paragraphs: string[]) {
  return {
    content: [
      {
        input: JSON.stringify({ type: "answer", paragraphs, followUp: null }),
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

function finalOutputResultWithFollowUp(paragraph: string, question: string) {
  return {
    ...finalOutputResult(paragraph),
    content: [
      {
        input: JSON.stringify({
          type: "answer",
          paragraphs: [paragraph],
          followUp: { purpose: "decision_support", text: question },
        }),
        toolCallId: "final-output-call",
        toolName: "final_output",
        type: "tool-call" as const,
      },
    ],
  };
}

function finalClarificationResult(question: string) {
  return {
    ...finalOutputResult("unused"),
    content: [
      {
        input: JSON.stringify({ type: "clarification", paragraphs: [question], followUp: null }),
        toolCallId: "final-output-call",
        toolName: "final_output",
        type: "tool-call" as const,
      },
    ],
  };
}

function offeredTools(model: MockLanguageModelV3) {
  return model.doGenerateCalls.map((call) => (call.tools ?? []).map((tool) => tool.name).toSorted());
}

const modelUsage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 5, total: 5 },
};

import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { Effect, Layer, Tracer } from "effect";
import { DialogueContinuation } from "@/ai/dialogue-continuation";
import { TelegramDelivery } from "@/conversation/delivery";
import { Database } from "@/services/database";

test.each(["addressed", "random"] as const)(
  "test_evaluates_$0_opportunity_when_bot_has_never_spoken",
  async (trigger) => {
    const result = await runDecision({ trigger });
    expect(result.decision).toEqual({ type: "text" });
    expect(result.state).toMatchObject({ trigger, explicitAddressing: trigger === "addressed" });
  },
);

test("test_stays_silent_when_continuation_has_no_prior_bot_reply", async () => {
  const result = await runDecision({ trigger: "continuation" });
  expect(result.decision).toEqual({ type: "silence" });
});

test.each([
  { count: 4, expected: "text" },
  { count: 5, expected: "silence" },
])("test_limits_continuation_when_$count_messages_follow_the_bot", async (row) => {
  const result = await runDecision({
    messageIds: Array.from({ length: row.count }, (_, index) => 51 + index),
    replyMessageId: 50,
    trigger: "continuation",
  });
  expect(result.decision).toEqual({ type: row.expected });
});

test.each(["addressed", "random"] as const)(
  "test_keeps_$0_opportunity_when_continuation_window_has_expired",
  async (trigger) => {
    const result = await runDecision({ messageIds: [55, 54, 53, 52, 51], replyMessageId: 50, trigger });
    expect(result.decision).toEqual({ type: "text" });
  },
);

test.each([
  { probability: 0.79, expected: "silence" },
  { probability: 0.8, expected: "text" },
])("test_gates_text_on_selected_probability_when_probability_is_$probability", async (row) => {
  const result = await runDecision({ probability: row.probability });
  expect(result.decision).toEqual({ type: row.expected });
});

test.each(["addressed", "random"] as const)(
  "test_stays_silent_for_$0_opportunity_when_jev_selects_silence",
  async (trigger) => {
    const result = await runDecision({ action: "silence", trigger });
    expect(result.decision).toEqual({ type: "silence" });
  },
);

test("test_preserves_reaction_without_generating_text_when_jev_selects_acknowledgement", async () => {
  const result = await runDecision({ action: "reaction" });
  expect(result.decision).toEqual({ type: "reaction", emoji: "👍" });
});

test("test_supplies_ordered_context_and_reply_target_when_deciding_participation", async () => {
  const result = await runDecision({ messageIds: [58, 49], replyMessageId: 50 });
  expect(result.state).toMatchObject({
    assistant: { name: "Starlight", speakerId: "42" },
    currentMessage: {
      messageId: 70,
      replyTo: { messageId: 50, senderId: 42, text: "Первый ответ" },
      speakerId: "7",
    },
    recentExchange: [
      { messageId: 49, speakerId: "7", replyToMessageId: 40, repliedText: "Вопрос" },
      { messageId: 50, speakerId: "42", text: "Первый ответ" },
      { messageId: 58, speakerId: "7", text: "Сообщение 58" },
    ],
  });
});

test.each([true, false])("test_withholds_decision_payloads_when_chat_privacy_is_$0", async (isPrivate) => {
  const result = await runDecision({ isPrivate });
  const span = result.spans.find((item) => item.name === "DialogueContinuation.evaluate")!;
  expect(span.attributes.has("langfuse.observation.input")).toBe(!isPrivate);
  expect(span.attributes.has("langfuse.observation.output")).toBe(!isPrivate);
  expect(result.decision).toEqual({ type: "text" });
});

async function runDecision(options: {
  readonly action?: "text" | "reaction" | "silence";
  readonly isPrivate?: boolean;
  readonly messageIds?: readonly number[];
  readonly probability?: number;
  readonly replyMessageId?: number;
  readonly trigger?: DialogueContinuation.Input["trigger"];
}) {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: "postgresql://test:test@127.0.0.1:1/test" }),
  }).$extends({
    query: {
      chat: {
        findUniqueOrThrow: () => Promise.resolve({ isPrivate: options.isPrivate ?? false }),
      },
      conversationInput: {
        findMany: () =>
          Promise.resolve(
            (options.messageIds ?? []).map((messageId) => ({
              sourceMessageId: messageId,
              payload: {
                replyToMessageId: 40,
                repliedText: "Вопрос",
                senderFirstName: "Vlad",
                senderId: 7,
                text: `Сообщение ${messageId}`,
              },
            })),
          ),
      },
      conversationRunAction: {
        findMany: () =>
          Promise.resolve(
            options.replyMessageId === undefined
              ? []
              : [
                  {
                    telegramMessageId: options.replyMessageId,
                    payload: { type: "text", text: "Первый ответ" },
                  },
                ],
          ),
      },
    },
  }) as PrismaClient;
  const requests: Parameters<Experimental_DecisionMockModelV4["doDecide"]>[0][] = [];
  const model = new Experimental_DecisionMockModelV4({
    doDecide: (request) => {
      requests.push(request);
      const action = options.action ?? "text";
      const probability = options.probability ?? 0.95;
      return Promise.resolve({
        answers: {
          action: {
            type: "choice",
            choice: action,
            probabilities: Object.fromEntries(
              ["text", "reaction", "silence"].map((item) => [
                item,
                item === action ? probability : (1 - probability) / 2,
              ]),
            ),
          },
          emoji: {
            type: "choice",
            choice: "👍",
            probabilities: Object.fromEntries(
              TelegramDelivery.reactionEmojis.map((emoji) => [emoji, emoji === "👍" ? 1 : 0]),
            ),
          },
        },
        warnings: [],
      });
    },
  });
  const spans: Tracer.Span[] = [];
  const decision = await Effect.runPromise(
    Effect.gen(function* () {
      const evaluator = yield* DialogueContinuation.Service;
      return yield* evaluator.evaluate({
        key: { assistantId: 42, chatId: -77, threadKey: 9 },
        messageId: 70,
        replyTo: { messageId: 50, senderId: 42, senderFirstName: "Starlight", text: "Первый ответ" },
        senderFirstName: "Vlad",
        senderId: 7,
        text: "А почему?",
        trigger: options.trigger ?? "addressed",
      });
    }).pipe(
      Effect.provide(
        DialogueContinuation.layer(model, { messageLimit: 5 }).pipe(
          Layer.provide(
            Layer.succeed(Database.Service)({
              query: (operation) => Effect.promise(() => operation(client)),
              transaction: () => Effect.die(new Error("Unexpected transaction")),
            }),
          ),
        ),
      ),
      Effect.withTracer(
        Tracer.make({
          span: (input) => {
            const span = new Tracer.NativeSpan(input);
            spans.push(span);
            return span;
          },
        }),
      ),
    ),
  );
  await client.$disconnect();
  return { decision, spans, state: requests[0]?.state };
}

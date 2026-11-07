import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { TelegramDelivery } from "@/conversation/delivery";
import { Dispatch } from "@/conversation/dispatch";
import { LaneDoc } from "@/conversation/lane-doc";

const previous: Dispatch.Result = { error: null, status: "delivered", telegramMessageId: 10 };

const legacyCheckpoint = {
  attempts: 0,
  deliveryOpen: true,
  inFlight: false,
  index: 1,
  notBefore: null as number | null,
  phase: "send" as const,
  results: [previous],
  textDelivered: true,
  unknownRetried: false,
};

// Our product must pace retries without repeating the text gap, because a transient Telegram
// failure must not duplicate earlier replies or leave the remainder of the reply unsent.
test.each([
  { random: 0, gap: 1500 },
  { random: 0.413, gap: 1913 },
  { random: 0.999999, gap: 2500 },
])("test_text_gap_is_sampled_once_when_second_text_retries_with_random_$random", async (scenario) => {
  const run = await deliver({
    actions: [
      { text: "first", type: "text" },
      { emoji: "👍", messageId: 7, type: "reaction" },
      { text: "second", type: "text" },
    ],
    outcomes: ["ok", "ok", "transient", "ok"],
    random: scenario.random,
  });

  expect(run.times).toEqual([0, 0, scenario.gap, scenario.gap + 1000]);
  expect(run.randomCalls).toBe(1);
  expect(run.results).toEqual([
    { error: null, status: "delivered", telegramMessageId: 101 },
    { error: null, status: "delivered", telegramMessageId: null },
    { error: null, status: "delivered", telegramMessageId: 104 },
  ]);
  expect(run.lane?.recentReplies).toEqual(["first", "second"]);
});

test("test_delivery_stops_after_four_known_failures_and_skips_the_segment", async () => {
  const run = await deliver({
    actions: [
      { text: "first", type: "text" },
      { text: "skipped", type: "text" },
    ],
    outcomes: ["transient", "transient", "transient", "transient"],
  });

  expect(run.times).toEqual([0, 1000, 3500, 8500]);
  expect(run.results).toEqual([
    { error: "transient", status: "failed", telegramMessageId: null },
    { error: Dispatch.SKIPPED, status: "failed", telegramMessageId: null },
  ]);
});

// Our product must allow only one cautious unknown-outcome retry, including after a known
// failure, because Telegram may already have shown a message whose acknowledgement was lost.
test.each([
  { outcomes: ["unknown", "unknown", "ok"], times: [0, 0], status: "failed" },
  { outcomes: ["unknown", "transient", "unknown", "ok"], times: [0, 0, 2500], status: "failed" },
  { outcomes: ["transient", "transient", "transient", "unknown"], times: [0, 1000, 3500, 8500], status: "failed" },
  { outcomes: ["unknown", "ok"], times: [0, 0], status: "delivered" },
] satisfies { outcomes: Outcome[]; times: number[]; status: Dispatch.Result["status"] }[])(
  "test_unknown_outcome_retry_is_bounded_when_outcomes_are_$outcomes",
  async (scenario) => {
    const run = await deliver({ actions: [{ text: "answer", type: "text" }], outcomes: scenario.outcomes });
    expect(run.times).toEqual(scenario.times);
    expect(run.results[0]?.status).toBe(scenario.status);
  },
);

test.each([false, true])("test_model_suffix_reopens_after_prefix_failure_when_suffix_fails_%s", async (suffixFails) => {
  const run = await deliver({
    actions: [
      { emoji: "👍", messageId: 7, type: "reaction" },
      { emoji: "🔥", messageId: 8, type: "reaction" },
      { text: "suffix", type: "text" },
      { text: "remainder", type: "text" },
    ],
    outcomes: ["permanent", suffixFails ? "permanent" : "ok", "ok"],
    prefix: 2,
  });

  expect(run.sent).toEqual(suffixFails ? ["reaction", "suffix"] : ["reaction", "suffix", "remainder"]);
  expect(run.results.map((result) => result.status)).toEqual([
    "failed",
    "failed",
    suffixFails ? "failed" : "delivered",
    suffixFails ? "failed" : "delivered",
  ]);
  expect(run.results[1]?.error).toBe(Dispatch.SKIPPED);

  if (suffixFails) expect(run.results[3]?.error).toBe(Dispatch.SKIPPED);
});

test("test_ignore_reopens_delivery_when_it_follows_a_failed_action", async () => {
  const run = await deliver({
    actions: [{ text: "failed", type: "text" }, { type: "ignore" }, { text: "answer", type: "text" }],
    outcomes: ["permanent", "ok"],
  });

  expect(run.sent).toEqual(["failed", "answer"]);
  expect(run.results.map((result) => result.status)).toEqual(["failed", "delivered", "delivered"]);
});

// Our product must resume v1 deliveries without resending completed actions, redrawing a
// persisted gap, or replenishing the unknown retry, because deploys must not duplicate replies.
test.each([
  { checkpoint: {}, until: 0, outcomes: ["ok"], times: [1500], error: null },
  { checkpoint: { notBefore: 2301 }, until: 2301, outcomes: ["ok"], times: [2301], error: null },
  {
    checkpoint: { attempts: 3, notBefore: 1700 },
    until: 7300,
    outcomes: ["transient"],
    times: [7300],
    error: "transient",
  },
  {
    checkpoint: { attempts: 1, inFlight: true, notBefore: 1700 },
    until: 0,
    outcomes: ["unknown"],
    times: [0],
    error: "unknown",
  },
  {
    checkpoint: { attempts: 1, unknownRetried: true, notBefore: 1700 },
    until: 0,
    outcomes: ["unknown"],
    times: [0],
    error: "unknown",
  },
  {
    checkpoint: { attempts: 2, unknownRetried: true, notBefore: 1700 },
    until: 4100,
    outcomes: ["unknown"],
    times: [4100],
    error: "unknown",
  },
  {
    checkpoint: { attempts: 2, inFlight: true, unknownRetried: true, notBefore: 1700 },
    until: 0,
    outcomes: [],
    times: [],
    error: "Telegram delivery outcome remained unknown after one retry",
  },
  { checkpoint: { attempts: 4, inFlight: true, notBefore: 1700 }, until: 0, outcomes: ["ok"], times: [0], error: null },
] satisfies {
  checkpoint: Partial<typeof legacyCheckpoint>;
  until: number;
  outcomes: Outcome[];
  times: number[];
  error: string | null;
}[])("test_v1_delivery_resumes_without_resetting_progress_when_checkpoint_is_$checkpoint", async (scenario) => {
  const run = await deliver({
    actions: [
      { text: "already sent", type: "text" },
      { text: "answer", type: "text" },
    ],
    legacy: { checkpoint: scenario.checkpoint, until: scenario.until },
    outcomes: scenario.outcomes,
  });

  expect(run.times).toEqual(scenario.times);
  expect(run.sent.every((text) => text === "answer")).toBe(true);
  expect(run.results).toHaveLength(2);
  expect(run.results[0]).toEqual(previous);
  expect(run.results[1]?.error).toBe(scenario.error);
});

type Outcome = "ok" | "transient" | "unknown" | "permanent";

async function deliver(options: {
  actions: TelegramDelivery.Action[];
  outcomes: Outcome[];
  prefix?: number;
  random?: number;
  legacy?: { checkpoint: Partial<typeof legacyCheckpoint>; until: number };
}) {
  const clock = { now: 0 };
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const times: number[] = [];
  const sent: string[] = [];
  const samples = { count: 0 };

  const task = Dispatch.task({
    deliver: async (input) => {
      times.push(clock.now);
      sent.push(input.action.type === "text" ? input.action.text : input.action.type);
      // The external send must observe a durable intent, not just an in-memory transition.
      const stored = await storage.scanTasks({}, 10, undefined, BACKGROUND_CONTEXT);
      expect(stored.items[0]?.state).toMatchObject({
        status: "running",
        checkpoint: stored.items[0]?.version === 1 ? { inFlight: true } : { phase: "in-flight" },
      });
      const outcome = options.outcomes[times.length - 1];
      expect(outcome).toBeDefined();

      if (outcome === "ok") {
        return { receipt: { telegramMessageId: input.action.type === "text" ? 100 + times.length : null } };
      }

      return {
        error: new TelegramDelivery.DeliveryError({
          cause: null,
          message: outcome!,
          outcomeUnknown: outcome === "unknown",
          retryable: outcome !== "permanent",
        }),
      };
    },
    random: () => {
      samples.count += 1;

      return options.random ?? 0;
    },
  });

  const extension = defineExtension({ name: "dispatch-test", tasks: [task] });

  const legacy = defineTask<Dispatch.Input, typeof legacyCheckpoint, Dispatch.Result[]>({
    name: task.definition.name,
    version: 1,
    initial: () => ({ ...legacyCheckpoint, ...options.legacy?.checkpoint }),
    phases: {
      send: async (current, runtime, context) => {
        await runtime.sleepUntil(options.legacy!.until, current.state.checkpoint, context);
        registry.install(extension);
      },
    },
    abort: async (_current, runtime, context) => {
      await runtime.commit(() => ({ outcome: { status: "aborted" }, status: "terminal" }), context);
    },
  });

  registry.install(
    options.legacy === undefined ? extension : defineExtension({ name: extension.name, tasks: [legacy] }),
  );

  const harness = await Harness.open(
    storage,
    {
      models: createModels(),
      registry,
      now: () => clock.now,
      onWake: (wake) => {
        if (wake.active || wake.at === undefined) return;
        clock.now = wake.at;
        harness.resume();
      },
    },
    BACKGROUND_CONTEXT,
  );

  const created = await harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const lane = await tx.doc(LaneDoc.token, conversation.id);
    lane.key = { assistantId: 1, chatId: 42, threadKey: 3 };
    const input = { actions: options.actions, chatId: 42, prefix: options.prefix ?? 0, threadKey: 3 };

    const taskId =
      options.legacy === undefined
        ? await tx.createTask(task, input, { conversationId: conversation.id, ownership: { kind: "conversation" } })
        : await tx.createTask(legacy, input, { conversationId: conversation.id, ownership: { kind: "conversation" } });

    return { conversationId: conversation.id, taskId };
  }, BACKGROUND_CONTEXT);

  const settled = await harness.waitForTask(created.taskId, BACKGROUND_CONTEXT);
  const lane = await harness.snapshot(LaneDoc.token, created.conversationId, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  expect(settled.state.outcome.status).toBe("completed");

  if (settled.state.outcome.status !== "completed") throw new Error("Delivery task did not complete");

  return { lane, randomCalls: samples.count, results: settled.state.outcome.result, sent, times };
}

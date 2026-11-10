import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, createSession, defineDoc, defineExtension, Harness } from "@earendil-works/pi-durable";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Dispatch } from "@/conversation/dispatch";
import { ConversationKey } from "@/conversation/key";
import { Lane } from "@/conversation/lane";
import { LaneDoc } from "@/conversation/lane-doc";
import { Reply } from "@/conversation/reply";

// Our product must answer an edited message even when the same lane task already answered its
// earlier revision, because reusing the earlier submission silently drops the user's edit.
test("test_edited_message_gets_its_own_answer_when_edit_arrives_during_running_batch", async () => {
  const firstAsked = Promise.withResolvers<null>();
  const firstAnswer = Promise.withResolvers<null>();
  const settled = Promise.withResolvers<null>();
  const prompts: string[] = [];
  const delivered: string[] = [];
  const recorded: string[] = [];
  const timing = { maxWaitMs: 0, quietMs: 0 };

  const faux = fauxProvider({ models: [{ id: "faux-1" }], provider: "faux" });

  const answer = async (context: { messages: readonly { content: unknown; role: string }[] }) => {
    prompts.push(JSON.stringify(context.messages.findLast((message) => message.role === "user")?.content));

    if (prompts.length === 1) {
      firstAsked.resolve(null);
      await firstAnswer.promise;
    }

    return fauxAssistantMessage(
      fauxToolCall(Reply.FINAL_OUTPUT, {
        replies: [{ replyTo: null, text: `answer ${prompts.length}`, type: "text" }],
      }),
      { stopReason: "toolUse" },
    );
  };

  faux.setResponses([answer, answer]);
  const models = createModels();
  models.setProvider(faux.provider);

  const delivery = Dispatch.task({
    deliver: async (input) => {
      delivered.push(input.action.type === "text" ? input.action.text : input.action.type);

      return await Promise.resolve({ receipt: { telegramMessageId: 1000 + delivered.length } });
    },
    random: () => 0,
  });

  const lane = Lane.task({
    chat: async () => await Promise.resolve({ isPremium: true, isPrivate: true, title: null }),
    delivery,
    log: () => {},
    recall: async () => await Promise.resolve(null),
    record: async (_key, batch) => {
      recorded.push(...batch.map((item) => item.payload.text));

      if (recorded.length === 2) settled.resolve(null);

      await Promise.resolve();
    },
    timing,
    typing: async () => {
      await Promise.resolve();
    },
  });

  const registry = createRegistry();
  registry.install(
    Reply.extension({
      delivery,
      flushMemory: async () => {
        await Promise.resolve();
      },
      loadMedia: async () => await Promise.resolve([]),
      research: {},
      summarize: async () => await Promise.resolve(""),
    }),
  );
  registry.install(defineExtension({ name: "starlight.lanes", tasks: [lane] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  harness.resume();

  const admit = async (text: string, editDate: number | null, updateId: number) =>
    await harness.commit(
      async (tx) =>
        await Lane.admit(tx, {
          agent: { model: { modelId: "faux-1", provider: "faux" } },
          item: {
            payload: {
              addressed: true,
              date: 1_700_000_000,
              editDate,
              forwardedFromSelf: false,
              forwardOrigin: null,
              media: [],
              mediaGroupId: null,
              messageId: 100,
              repliedMedia: [],
              repliedText: null,
              replyToMessageId: null,
              senderFirstName: "Ann",
              senderId: 7,
              senderUsername: null,
              text,
            },
            senderUserId: null,
          },
          key: { assistantId: 1, chatId: 42, threadKey: 0 },
          now: 0,
          task: lane,
          timing,
          updateId,
        }),
      BACKGROUND_CONTEXT,
    );

  await admit("original question", null, 1);
  await firstAsked.promise;
  await admit("edited question", 1_700_000_100, 2);
  firstAnswer.resolve(null);
  await settled.promise;
  await harness.close(BACKGROUND_CONTEXT);

  expect(recorded).toEqual(["original question", "edited question"]);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("edited question");
  expect(delivered).toEqual(["answer 1", "answer 2"]);
});

// Our product must preserve admitted work and its owner across upgrades, because losing either
// can drop pending messages or let a second runner answer a batch already in progress.
test.each(["idle", "gathering", "claimed", "released"])(
  "test_persisted_lane_keeps_work_and_ownership_when_upgrading_%s",
  async (state) => {
    const storage = new MemoryStorage();
    const session = createSession(storage, { now: () => 1000 });
    const taskId = await storage.mintId<TaskId>();
    const key = { assistantId: 1, chatId: 42, threadKey: 0 };
    const pending = state === "idle" || state === "released" ? [] : [laneItem(100, "pending")];
    const window = state === "idle" || state === "released" ? null : { firstPendingAt: 1000, wakeAt: 5000 };

    const recent = [
      {
        messageId: 9,
        repliedText: null,
        replyToMessageId: null,
        speaker: "Ann",
        speakerId: "7",
        text: "earlier message",
      },
    ];

    const ownership: LaneDoc.Value["ownership"] =
      state === "claimed" || state === "released"
        ? { kind: "claimed", taskId }
        : { kind: "unclaimed", sleeper: state === "gathering" ? { taskId, until: 4000 } : null };

    const legacy = defineDoc<JsonObject>({
      kind: "starlight.lane",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({
        admittedKeys: ["update:99"],
        firstPendingAt: window?.firstPendingAt ?? null,
        key,
        pending,
        recent,
        recentReplies: ["earlier answer"],
        runner: ownership.kind === "claimed" ? taskId : null,
        seenMessageIds: [9],
        sleeper: ownership.kind === "unclaimed" ? ownership.sleeper : null,
        wakeAt: window?.wakeAt ?? null,
      }),
      checkpointWhen: () => false,
    });

    try {
      const conversationId = await session.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await tx.doc(legacy, conversation.id);

        return conversation.id;
      }, BACKGROUND_CONTEXT);

      // Include an old-shape delta, not only an initial base.
      await session.commit(async (tx) => {
        const draft = await tx.doc(legacy, conversationId);
        draft.seenMessageIds = [9, 10];
      }, BACKGROUND_CONTEXT);

      const expected = {
        admittedKeys: ["update:99"],
        key,
        ownership,
        pending,
        recent,
        recentReplies: ["earlier answer"],
        seenMessageIds: [9, 10],
        window,
      };

      expect(await session.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT)).toEqual(expected);

      await session.commit(async (tx) => {
        await tx.doc(LaneDoc.token, conversationId);
      }, BACKGROUND_CONTEXT);

      const record = await storage.findDocument(
        { kind: "starlight.lane", scope: { kind: "conversation", conversationId } },
        "current",
        BACKGROUND_CONTEXT,
      );

      const stored = await storage.document(record!.id, "current", BACKGROUND_CONTEXT);
      expect(stored?.version).toBe(2);
      expect(stored?.value).toEqual(expected);
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  },
);

// Our product must gather albums, replace only sleepers that would wake too late, and keep one
// runner through release, because premature or duplicate claims split or duplicate answers.
test("test_lane_preserves_batch_windows_and_single_runner_when_deadlines_move", async () => {
  const clock = { now: 1000 };

  const sleeps = new Map<number, ReturnType<typeof Promise.withResolvers<null>>>(
    [36_000, 5000, 6000, 10_000].map((until) => [until, Promise.withResolvers<null>()]),
  );

  const firstRun = Promise.withResolvers<null>();
  const releaseFirst = Promise.withResolvers<null>();
  const batches: string[][] = [];
  const timing = { maxWaitMs: 10_000, quietMs: 3000 };
  const key = { assistantId: 1, chatId: 42, threadKey: 0 };

  const delivery = Dispatch.task({
    deliver: async () => await Promise.resolve({ receipt: { telegramMessageId: null } }),
    random: () => 0,
  });

  const lane = Lane.task({
    chat: async () => await Promise.resolve({ isPremium: true, isPrivate: true, title: null }),
    delivery,
    log: () => {},
    recall: async () => await Promise.resolve(null),
    record: async (_key, batch) => {
      batches.push(batch.map((input) => input.payload.text));

      if (batches.length === 1) {
        firstRun.resolve(null);
        await releaseFirst.promise;
      }
    },
    timing,
    typing: async () => {
      await Promise.resolve();
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: "starlight.lanes", tasks: [lane] }));

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      now: () => clock.now,
      onWake: (wake) => {
        if (!wake.active && wake.at !== undefined) sleeps.get(wake.at)?.resolve(null);
      },
      registry,
    },
    BACKGROUND_CONTEXT,
  );

  const admit = async (input: LaneDoc.Item, updateId: number) =>
    await harness.commit(
      async (tx) =>
        await Lane.admit(tx, {
          agent: { model: { modelId: "unused", provider: "unused" } },
          item: input,
          key,
          now: clock.now,
          task: lane,
          timing,
          updateId,
        }),
      BACKGROUND_CONTEXT,
    );

  try {
    await admit(laneItem(100, "album", "album-1"), 1);
    const index = await harness.snapshot(LaneDoc.index, ConversationKey.format(key), BACKGROUND_CONTEXT);
    const conversationId = index!.conversationId!;
    const initial = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);
    expect(initial?.window).toEqual({ firstPendingAt: 1000, wakeAt: 36_000 });
    expect(initial?.ownership.kind).toBe("unclaimed");

    if (initial?.ownership.kind !== "unclaimed") throw new Error("Expected an unclaimed lane");
    const oldSleeper = initial.ownership.sleeper!.taskId;
    harness.resume();
    await sleeps.get(36_000)!.promise;

    clock.now = 2000;
    await admit(laneItem(101, "earlier"), 2);
    await sleeps.get(5000)!.promise;
    const earlier = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);

    if (earlier?.ownership.kind !== "unclaimed") throw new Error("Expected an unclaimed lane");
    const runner = earlier.ownership.sleeper!.taskId;
    expect(runner).not.toBe(oldSleeper);
    const sleeping = await harness.getTask(oldSleeper, BACKGROUND_CONTEXT);
    expect(sleeping?.state.status).toBe("sleeping");

    await admit(laneItem(104, "same deadline"), 5);
    const same = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);
    expect(same?.ownership).toEqual({ kind: "unclaimed", sleeper: { taskId: runner, until: 5000 } });

    clock.now = 3000;
    await admit(laneItem(102, "later"), 3);
    const later = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);
    expect(later?.ownership).toEqual({ kind: "unclaimed", sleeper: { taskId: runner, until: 5000 } });
    expect(later?.window).toEqual({ firstPendingAt: 1000, wakeAt: 6000 });
    expect(await admit(laneItem(102, "later"), 3)).toEqual({ duplicate: true });

    clock.now = 5000;
    harness.resume();
    await sleeps.get(6000)!.promise;
    expect(batches).toEqual([]);

    clock.now = 6000;
    harness.resume();
    await firstRun.promise;
    clock.now = 7000;
    await admit(laneItem(103, "during run"), 4);
    const claimed = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);
    expect(claimed?.ownership).toEqual({
      kind: "claimed",
      taskId: runner,
    });
    releaseFirst.resolve(null);
    await sleeps.get(10_000)!.promise;
    const released = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);
    expect(released?.ownership).toEqual({ kind: "claimed", taskId: runner });
    expect(released?.window).toEqual({ firstPendingAt: 7000, wakeAt: 10_000 });

    clock.now = 10_000;
    harness.resume();
    await harness.waitForTask(runner, BACKGROUND_CONTEXT);
    const idle = await harness.snapshot(LaneDoc.token, conversationId, BACKGROUND_CONTEXT);
    expect(idle?.ownership).toEqual({ kind: "unclaimed", sleeper: null });
    expect(idle?.window).toBeNull();
    expect(idle?.pending).toEqual([]);

    clock.now = 36_000;
    harness.resume();
    await harness.waitForTask(oldSleeper, BACKGROUND_CONTEXT);
    expect(batches).toEqual([["album", "earlier", "later", "same deadline"], ["during run"]]);
  } finally {
    releaseFirst.resolve(null);
    await harness.close(BACKGROUND_CONTEXT);
  }
});

// Our product must give the model a batch in Telegram message order, because media ingestion delays
// admission and an out-of-order batch makes the reply answer the wrong message.
test("test_batch_is_frozen_in_message_order_when_a_later_message_is_admitted_first", () => {
  const lane = LaneDoc.empty();
  const timing = { maxWaitMs: 10_000, quietMs: 3000 };

  LaneDoc.admit(lane, laneItem(11, "second"), 1, 0, timing);
  LaneDoc.admit(lane, laneItem(10, "first"), 2, 0, timing);

  expect(LaneDoc.freeze(lane).map((item) => item.payload.text)).toEqual(["first", "second"]);
});

function laneItem(messageId: number, text: string, mediaGroupId: string | null = null): LaneDoc.Item & JsonObject {
  return {
    payload: {
      addressed: false,
      date: 1_700_000_000,
      editDate: null,
      forwardedFromSelf: false,
      forwardOrigin: null,
      media: [],
      mediaGroupId,
      messageId,
      repliedMedia: [],
      repliedText: null,
      replyToMessageId: null,
      senderFirstName: "Ann",
      senderId: 7,
      senderUsername: null,
      text,
    },
    senderUserId: null,
  };
}

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Dispatch } from "@/conversation/dispatch";
import { Lane } from "@/conversation/lane";
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

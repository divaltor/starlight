import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { tool } from "ai";
import { z } from "zod";
import { ChatReply } from "@/ai/chat-reply";
import { Dispatch } from "@/conversation/dispatch";
import { LaneDoc } from "@/conversation/lane-doc";
import { Reply } from "@/conversation/reply";

// Our product must bound all research output per reply, including concurrent tools, because
// independent allowances can otherwise multiply the context budget by the number of calls.
test("test_research_output_stays_within_reply_budget_when_tools_finish_together", async () => {
  const started = Promise.withResolvers<null>();
  const executed: number[] = [];
  const outputs: string[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }], provider: "faux" });
  faux.setResponses([
    fauxAssistantMessage(
      [1, 2, 3, 4].map((id) => fauxToolCall("research", { id }, { id: `research-${id}` })),
      { stopReason: "toolUse" },
    ),
    (context) => {
      outputs.push(
        ...context.messages.flatMap((message) =>
          message.role === "toolResult" && !message.isError
            ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [],
        ),
      );

      return fauxAssistantMessage(fauxToolCall(Reply.FINAL_OUTPUT, { replies: [{ type: "ignore" }] }), {
        stopReason: "toolUse",
      });
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    Reply.extension({
      delivery: Dispatch.task({
        deliver: async () => await Promise.resolve({ receipt: { telegramMessageId: null } }),
        random: () => 0,
      }),
      flushMemory: async () => {
        await Promise.resolve();
      },
      loadMedia: async () => await Promise.resolve([]),
      research: {
        research: tool({
          inputSchema: z.object({ id: z.number() }),
          execute: async (args) => {
            executed.push(args.id);

            if (executed.length === 3) started.resolve(null);
            await started.promise;

            return 'é"\n'.repeat(20_000);
          },
        }),
      },
      summarize: async () => await Promise.resolve(""),
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);

  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { modelId: "faux-1", provider: "faux" } },
      init: async (tx, conversationId) => {
        const lane = await tx.doc(LaneDoc.token, conversationId);
        lane.key = { assistantId: 1, chatId: 42, threadKey: 0 };
        const run = await tx.doc(Reply.runDoc, conversationId);
        run.marker = "question";
      },
    });

    const submission = await conversation.submit({ content: "question", type: "input" }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
    expect(executed.toSorted((left, right) => left - right)).toEqual([1, 2, 3]);
    expect(outputs).toHaveLength(3);
    expect(
      outputs.reduce((bytes, output) => bytes + new TextEncoder().encode(output).byteLength, 0),
    ).toBeLessThanOrEqual(ChatReply.maxToolOutputBytes);
    expect(outputs.join("")).toContain("é");
    expect(outputs.join("")).not.toContain("�");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

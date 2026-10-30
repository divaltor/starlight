import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  CompactionTask,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { ConversationId, JsonObject, TaskId, ToolExecutionResult, Tx } from "@earendil-works/pi-durable";
import { asSchema } from "ai";
import type { Tool, ToolSet } from "ai";
import { z } from "zod";
import { ChatReply } from "@/ai/chat-reply";
import { Prompt } from "@/context/prompt";
import type { TelegramDelivery } from "@/conversation/delivery";
import type { Dispatch } from "@/conversation/dispatch";
import type { ConversationKey } from "@/conversation/key";
import { LaneDoc } from "@/conversation/lane-doc";
import type { Media } from "@/media/media";

/**
 * The Starlight Pi extension: system prompt sections, the final_output tool that hands a reply
 * to durable delivery, research tools under the per-reply budget, and the hooks that keep the
 * stored transcript stable while each request sees the live batch with its media and metadata.
 */
export namespace Reply {
  export const FINAL_OUTPUT = "final_output";
  const MAX_NUDGES = 2;
  const SUMMARY_TOOL_OUTPUT_MAX_CHARS = 2000;
  const SUMMARY_INPUT_VERSION = "context-checkpoint-v4";

  const FINAL_OUTPUT_INSTRUCTION =
    "IMPORTANT: You MUST use the final_output tool to provide your final response. Complete any necessary research first, then call final_output exactly once. Do not return the final response as text.";

  const FINAL_OUTPUT_DESCRIPTION =
    "Return the complete final response in the required structured format. You must call this tool exactly once after completing any necessary research.";

  // Tool parameter schemas go to providers without the draft marker, which some reject.
  const toolSchema = z
    .record(z.string(), z.json())
    .transform((schema) => Object.fromEntries(Object.entries(schema).filter((entry) => entry[0] !== "$schema")));

  const NUDGE = "Use the final_output tool now to give your response. Do not answer as plain text.";

  // Frozen per run by the lane task, so retries and recovery render the same request.
  export interface RunValue {
    chatTitle: string | null;
    contextMemory: string | null;
    currentDate: string;
    isPrivate: boolean;
    // First text part of the batch input; locates the live batch among request messages.
    marker: string | null;
    media: { part: number; reference: Media.Reference }[];
    precomputed: TelegramDelivery.ReactionAction[];
    replyLimit: number;
    research: { bytes: number; taskId: number }[];
    // Telegram sender of the batch's last message.
    senderId: number | null;
    signOff: string | null;
  }

  export const runDoc = defineDoc<RunValue & JsonObject>({
    kind: "starlight.run",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({
      chatTitle: null,
      contextMemory: null,
      currentDate: "",
      isPrivate: true,
      marker: null,
      media: [],
      precomputed: [],
      replyLimit: 3,
      research: [],
      senderId: null,
      signOff: null,
    }),
    checkpointWhen: () => true,
  });

  // Links a final_output call to the delivery task it created, in the commit that created it.
  const deliveryRef = defineDoc<{ taskId: TaskId<Dispatch.Result[]> | null }>({
    kind: "starlight.delivery-ref",
    version: 1,
    scope: "task",
    initial: () => ({ taskId: null }),
    checkpointWhen: () => true,
  });

  export interface Deps {
    readonly delivery: Dispatch.Definition;
    readonly flushMemory: (key: ConversationKey.Value) => Promise<void>;
    readonly loadMedia: (references: readonly Media.Reference[]) => Promise<readonly Media.Loaded[]>;
    readonly research: ToolSet;
    readonly summarize: (input: string) => Promise<string>;
  }

  export function extension(deps: Deps) {
    // Bounds plain-text answers per run. In memory on purpose: a restart resets it, which still
    // bounds the loop, and no durable state is worth keeping for a misbehaving model turn.
    const nudges = new Map<number, { count: number; marker: string }>();

    return defineExtension({
      name: "starlight",
      sections: [
        section("persona", () => ChatReply.systemPrompt, { tag: false }),
        section(
          "chat",
          async (input, context) => {
            const run = await input.read.snapshot(runDoc, input.conversationId, context);

            return run?.chatTitle == null ? undefined : Prompt.renderChatMetadata(run.chatTitle);
          },
          { tag: false },
        ),
        section(
          "reply",
          async (input, context) => {
            const run = await input.read.snapshot(runDoc, input.conversationId, context);

            return `Reply-item limit for this chat: ${run?.replyLimit ?? 3}.\n\n${FINAL_OUTPUT_INSTRUCTION}`;
          },
          { tag: false },
        ),
      ],
      tools: [finalOutput(deps), ...Object.entries(deps.research).map((entry) => researchTool(entry[0], entry[1]))],
      tasks: [deps.delivery],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (request, api, context) => {
            const [run, lane] = await Promise.all([
              api.snapshot(runDoc, api.conversationId, context),
              api.snapshot(LaneDoc.token, api.conversationId, context),
            ]);

            // Pi starts the model request span under this phase, and it inherits these for Langfuse.
            context.telemetry.setAttributes({
              "langfuse.session.id": `${lane!.key!.chatId}/${lane!.key!.threadKey}`,
              "langfuse.user.id": run?.senderId?.toString(),
              "starlight.private": run?.isPrivate !== false,
            });

            if (run?.marker == null) return request;
            const batch = request.messages.findLast((message) => isBatch(message, run.marker!));

            if (batch === undefined) return request;
            const index = request.messages.indexOf(batch);
            const loaded = await deps.loadMedia(run.media.map((item) => item.reference));

            const content = batch.content.flatMap((part, partIndex) => [
              part,
              ...run.media.flatMap((item, mediaIndex) =>
                item.part === partIndex && loaded[mediaIndex] !== undefined ? [toPart(loaded[mediaIndex])] : [],
              ),
            ]);

            const metadata: UserMessage = {
              content: [
                { text: `${Prompt.requestMetadataHeader}\nCurrent date: ${run.currentDate}`, type: "text" },
                ...(run.contextMemory === null ? [] : [{ text: run.contextMemory, type: "text" as const }]),
              ],
              role: "user",
              timestamp: batch.timestamp,
            };

            return {
              messages: [
                ...request.messages.slice(0, index),
                metadata,
                {
                  ...batch,
                  content: [
                    ...content,
                    ...(run.signOff === null ? [] : [{ text: run.signOff, type: "text" as const }]),
                  ],
                },
                ...request.messages.slice(index + 1),
              ],
            };
          },
          onYield: async (answer, api, context) => {
            const run = await api.snapshot(runDoc, api.conversationId, context);
            const marker = run?.marker ?? null;
            const previous = nudges.get(api.conversationId);
            const count = previous !== undefined && previous.marker === marker ? previous.count : 0;
            const answered = answer.content.some((part) => part.type === "toolCall" && part.name === FINAL_OUTPUT);

            // oxlint-disable-next-line unicorn/no-useless-undefined -- Pi hooks signal "no change" with undefined
            if (answered || marker === null || count >= MAX_NUDGES) return undefined;
            nudges.set(api.conversationId, { count: count + 1, marker });

            return { continue: NUDGE };
          },
        }),
        hook(ToolTask, {
          afterTool: async (call, result, api, context) => {
            const run = await api.snapshot(runDoc, api.conversationId, context);

            // Same opt-in as model request content: only chats known to be non-private.
            if (run?.isPrivate === false) {
              context.telemetry.setAttributes({
                "langfuse.observation.input": JSON.stringify(call.arguments),
                "langfuse.observation.output": JSON.stringify(result.output ?? null),
              });
            }

            // oxlint-disable-next-line unicorn/no-useless-undefined -- Pi hooks signal "no change" with undefined
            return undefined;
          },
        }),
        hook(CompactionTask, {
          beforeCompact: async (compaction, api, context) => {
            const stored = await api.memo<string>("starlight.summary", context);

            if (stored !== undefined) return { summary: stored };
            const lane = await api.snapshot(LaneDoc.token, api.conversationId, context);

            // Hindsight must hold every fact the summary is about to drop before recall relies on it.
            if (lane?.key != null) await deps.flushMemory(lane.key);
            const compacted = CompactionEntry.is(compaction.entries[0]);
            const previousMemory = compacted ? textOf(compaction.messages[0]!) : "";
            const head = compacted ? compaction.messages.slice(1) : compaction.messages;

            const summary = Prompt.renderMemory({
              checkpoint: await deps.summarize(
                Prompt.canonicalEncode({
                  head: head.flatMap(summaryLine),
                  previousMemory,
                  version: SUMMARY_INPUT_VERSION,
                }),
              ),
              scopes: [],
            });

            return { summary: await api.memo("starlight.summary", summary, context) };
          },
        }),
      ],
    });
  }

  export function memoryCompacted(head: { readonly kind: string } | undefined): boolean {
    return head?.kind === CompactionEntry.kind;
  }

  function finalOutput(deps: Deps) {
    return defineTool({
      name: FINAL_OUTPUT,
      description: FINAL_OUTPUT_DESCRIPTION,
      parameters: jsonSchema(ChatReply.responseSchema),
      // A rerun after a crash finds the delivery task it already created instead of sending twice.
      replay: "safe",
      execute: async (args, api, context) => {
        const calls = await api.commit(async (tx) => await latestToolCalls(tx, api.conversationId), context);

        if (calls.length !== 1) {
          return failure("Call final_output alone, after every research result has come back.");
        }

        const [run, lane] = await Promise.all([
          api.snapshot(runDoc, api.conversationId, context),
          api.snapshot(LaneDoc.token, api.conversationId, context),
        ]);

        const parsed = ChatReply.responseSchema
          .extend({ replies: z.array(ChatReply.actionSchema).min(1).max(run!.replyLimit) })
          .safeParse(args);

        if (!parsed.success) return failure(z.prettifyError(parsed.error));
        const precomputed = run?.precomputed ?? [];
        const actions = mergePrecomputedReactions(precomputed, parsed.data.replies);

        const taskId = await api.commit(async (tx) => {
          const ref = await tx.doc(deliveryRef, api.taskId);

          if (ref.taskId !== null) return ref.taskId;

          const created = await tx.createTask(
            deps.delivery,
            {
              actions: [...actions],
              chatId: lane!.key!.chatId,
              prefix: Math.min(new Set(precomputed.map((action) => action.messageId)).size, actions.length),
              threadKey: lane!.key!.threadKey,
            },
            { ownership: { kind: "task", taskId: api.taskId } },
          );

          ref.taskId = created;

          return created;
        }, context);

        const settled = await api.waitForTask(taskId, context);
        const results = settled.state.outcome.status === "completed" ? settled.state.outcome.result : [];

        return {
          control: { terminate: true },
          output: [
            {
              text: Prompt.canonicalEncode(
                actions.map((action, index) => ({ action, delivery: results[index] ?? null })),
              ),
              type: "text",
            },
          ],
        };
      },
    });
  }

  function researchTool(name: string, definition: Tool) {
    const schema = asSchema(definition.inputSchema);

    return defineTool({
      name,
      description: typeof definition.description === "string" ? definition.description : name,
      parameters: Type.Unsafe(toolSchema.parse(schema.jsonSchema)),
      replay: "safe",
      execute: async (args, api, context) => {
        const slot = await api.commit(async (tx) => {
          const run = await tx.doc(runDoc, api.conversationId);
          const index = run.research.findIndex((item) => item.taskId === api.taskId);

          if (index !== -1) return { index, remaining: remainingBytes(run, api.taskId) };
          run.research.push({ bytes: 0, taskId: api.taskId });

          return { index: run.research.length - 1, remaining: remainingBytes(run, api.taskId) };
        }, context);

        if (slot.index >= ChatReply.maxToolCalls) {
          return failure("The research budget for this reply is spent. Answer now with final_output.");
        }

        const validated = await schema.validate!(args);

        if (!validated.success) return failure(validated.error.message);

        const output: unknown = await definition.execute!(validated.value, {
          context: null,
          messages: [],
          toolCallId: api.callId,
        });

        const text = bound(JSON.stringify(output) ?? String(output), slot.remaining);

        await api.commit(async (tx) => {
          const run = await tx.doc(runDoc, api.conversationId);
          const item = run.research.find((entry) => entry.taskId === api.taskId);

          if (item !== undefined) item.bytes = new TextEncoder().encode(text).byteLength;
        }, context);

        return { output: [{ text, type: "text" }] } satisfies ToolExecutionResult;
      },
    });
  }

  // Mixed batches must not silently drop Jev reactions when the model also replies.
  // Precomputed reactions come first so delivery attempts them before model text.
  // A model duplicate for the same message loses: Telegram reactions overwrite, so a
  // second reaction to the same message would only waste a delivery attempt. A model
  // ignore loses too: Jev already decided the message deserves a reaction.
  export function mergePrecomputedReactions(
    precomputed: readonly TelegramDelivery.ReactionAction[],
    generated: readonly ChatReply.Response["replies"][number][],
  ): readonly ChatReply.Response["replies"][number][] {
    if (precomputed.length === 0) return generated;

    const deduped = precomputed.filter(
      (reaction, index) => precomputed.findIndex((other) => other.messageId === reaction.messageId) === index,
    );

    const generatedWithoutPrecomputedTargets = generated.filter((action) => {
      if (action.type === "ignore") return false;

      if (action.type !== "reaction") return true;

      return !deduped.some((reaction) => reaction.messageId === action.messageId);
    });

    return [...deduped, ...generatedWithoutPrecomputedTargets];
  }

  async function latestToolCalls(tx: Tx, conversationId: ConversationId) {
    const page = await tx.scanEntries({ conversationId, order: "descending" }, 16);
    const assistant = page.items.find((entry) => AssistantEntry.is(entry));
    const message = assistant?.model?.find((item): item is AssistantMessage => item.role === "assistant");

    return message?.content.filter((part) => part.type === "toolCall") ?? [];
  }

  function remainingBytes(run: RunValue, taskId: number) {
    return Math.max(
      0,
      ChatReply.maxToolOutputBytes -
        run.research.filter((item) => item.taskId !== taskId).reduce((total, item) => total + item.bytes, 0),
    );
  }

  function bound(serialized: string, maximumBytes: number) {
    const encoded = new TextEncoder().encode(serialized);

    if (encoded.byteLength <= maximumBytes) return serialized;

    return JSON.stringify({
      originalBytes: encoded.byteLength,
      preview: new TextDecoder().decode(encoded.slice(0, Math.max(0, maximumBytes - 256))),
      truncated: true,
    });
  }

  function failure(message: string): ToolExecutionResult {
    return { isError: true, output: [{ text: message, type: "text" }] };
  }

  function jsonSchema(schema: z.ZodType) {
    return Type.Unsafe(toolSchema.parse(z.toJSONSchema(schema, { io: "input" })));
  }

  function isBatch(
    message: Message,
    marker: string,
  ): message is UserMessage & { content: (ImageContent | TextContent)[] } {
    return (
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content[0]?.type === "text" &&
      message.content[0].text === marker
    );
  }

  function toPart(item: Media.Loaded): ImageContent {
    return { data: Buffer.from(item.bytes).toString("base64"), mimeType: item.mimeType, type: "image" };
  }

  function textOf(message: Message): string {
    if (typeof message.content === "string") return message.content;

    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  }

  // Assistant turns reach the summarizer as delivered reply text only, so records keep what it
  // answered or promised without reaction and ignore envelopes.
  function summaryLine(message: Message): string[] {
    if (message.role === "assistant") {
      return message.content.flatMap((part) => {
        if (part.type !== "toolCall" || part.name !== FINAL_OUTPUT) return [];
        const parsed = ChatReply.responseSchema.safeParse(part.arguments);

        return parsed.success
          ? parsed.data.replies.flatMap((reply) =>
              reply.type === "text" ? [Prompt.canonicalEncode({ role: "assistant", text: reply.text })] : [],
            )
          : [];
      });
    }

    if (message.role === "toolResult") {
      if (message.toolName === FINAL_OUTPUT) return [];
      const text = textOf(message);

      return [
        text.length > SUMMARY_TOOL_OUTPUT_MAX_CHARS
          ? `${text.slice(0, SUMMARY_TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`
          : text,
      ];
    }

    const text = textOf(message);

    // Pi's system entries carry no conversation content.
    return message.role === "user" && text !== "" ? [Prompt.canonicalEncode({ role: message.role, text })] : [];
  }
}

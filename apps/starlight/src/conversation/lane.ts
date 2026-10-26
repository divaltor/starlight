import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { configure, defineTask } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentChange, EntryDraft, Task, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import { CanonicalJson } from "@/context/canonical-json";
import { Prompt } from "@/context/prompt";
import type { TelegramDelivery } from "@/conversation/delivery";
import type { Dispatch } from "@/conversation/dispatch";
import { ConversationKey } from "@/conversation/key";
import { LaneDoc } from "@/conversation/lane-doc";
import { Reply } from "@/conversation/reply";

/**
 * One Telegram lane (assistant, chat, topic) as a Pi conversation. A lane task waits out the
 * batching window, freezes a batch, and drives it to completion: a silent batch becomes
 * context, a batch answered only by Jev reactions goes straight to delivery, and anything else
 * becomes one input that Pi answers through final_output. Retryable failures back off and
 * retry the same frozen batch; permanent ones block only that batch.
 */
export namespace Lane {
  const MAX_REQUEST_MEDIA_BYTES = 20 * 1024 * 1024;
  const MAX_BACKOFF_MS = 300_000;
  const TYPING_INTERVAL_MS = 4000;
  const BATCH_ENTRY = "starlight.batch";
  const REACTIONS_ENTRY = "starlight.reactions";

  type State =
    | { readonly failures: number; readonly phase: "wait" }
    | { readonly batch: LaneDoc.Item[]; readonly failures: number; readonly phase: "run" }
    | { readonly batch: LaneDoc.Item[]; readonly phase: "answer"; readonly requestId: string }
    | { readonly batch: LaneDoc.Item[]; readonly phase: "settle" };

  type Runtime = TaskRuntime<null, State, null, object>;

  export interface Chat {
    readonly isPremium: boolean;
    readonly isPrivate: boolean;
    readonly title: string | null;
  }

  export interface Deps {
    readonly chat: (chatId: number) => Promise<Chat | null>;
    readonly delivery: Dispatch.Definition;
    readonly log: (
      level: "error" | "info" | "warn",
      message: string,
      fields: Readonly<Record<string, JsonValue | undefined>>,
    ) => void;
    // Long-term memory observations for a finalized batch; idempotent per message revision.
    readonly record: (key: ConversationKey.Value, batch: readonly LaneDoc.Item[]) => Promise<void>;
    readonly recall: (key: ConversationKey.Value, batch: readonly LaneDoc.Item[]) => Promise<string | null>;
    readonly timing: LaneDoc.Timing;
    // Best effort: never rejects.
    readonly typing: (key: ConversationKey.Value) => Promise<void>;
  }

  // A batch that no retry can answer; only that batch is dropped.
  export class BlockedError extends Schema.TaggedError<BlockedError>()("LaneBlockedError", {
    message: Schema.String,
    reason: Schema.String,
  }) {}

  export function task(deps: Deps) {
    return defineTask<null, State, null>({
      name: "starlight.lane",
      version: 1,
      initial: () => ({ failures: 0, phase: "wait" }),
      phases: {
        wait: async (current, runtime, context) => {
          await runtime.commit(async (tx) => {
            const lane = await tx.doc(LaneDoc.token, runtime.conversationId);

            if (lane.runner !== null && lane.runner !== current.id) return done();

            if (lane.pending.length === 0) {
              lane.runner = null;

              return done();
            }

            if (lane.wakeAt !== null && lane.wakeAt > runtime.now()) {
              return { checkpoint: current.state.checkpoint, status: "sleeping", until: lane.wakeAt } as const;
            }

            lane.runner = current.id;
            lane.sleeper = null;

            return running({ batch: LaneDoc.freeze(lane), failures: current.state.checkpoint.failures, phase: "run" });
          }, context);
        },
        run: async (current, runtime, context) => {
          const state = current.state.checkpoint;

          // One lane runner serves many batches, so each admitting update is a link rather than the parent.
          for (const carrier of state.batch.flatMap((item) => (item.trace === undefined ? [] : [item.trace]))) {
            context.telemetry.addLink({ context: context.telemetry.propagation!.extract(carrier) });
          }

          try {
            await start(deps, runtime, state, context);
          } catch (error) {
            // Effect tagged errors carry `retryable`; anything else is assumed transient.
            const retryable =
              typeof error === "object" && error !== null && "retryable" in error ? error.retryable : true;

            const permanent = error instanceof BlockedError || retryable === false;

            if (!permanent) {
              deps.log("warn", "Lane batch failed, retrying", {
                conversationId: runtime.conversationId,
                error: Bun.inspect(error),
                failures: state.failures + 1,
              });
              await runtime.sleepUntil(
                runtime.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** state.failures),
                { ...state, failures: state.failures + 1 },
                context,
              );

              return;
            }

            deps.log("error", "Lane batch blocked", {
              conversationId: runtime.conversationId,
              error: Bun.inspect(error),
              reason: error instanceof BlockedError ? error.reason : "permanent",
            });
            await release(deps, runtime, state.batch, context);
          }
        },
        answer: async (current, runtime, context) => {
          const state = current.state.checkpoint;

          // Pi links the reply's submission trace to this phase; linking the updates here connects both ends.
          for (const carrier of state.batch.flatMap((item) => (item.trace === undefined ? [] : [item.trace]))) {
            context.telemetry.addLink({ context: context.telemetry.propagation!.extract(carrier) });
          }

          const [lane, conversation] = await Promise.all([
            runtime.snapshot(LaneDoc.token, runtime.conversationId, context),
            runtime.conversation(runtime.conversationId, context),
          ]);

          // Same requestId as the original submission, so a rerun finds it instead of asking twice.
          const submission = await conversation!.submit(input(state.batch, lane!, state.requestId), context);
          const key = lane!.key!;

          const typing = setInterval(() => {
            void deps.typing(key);
          }, TYPING_INTERVAL_MS);

          void deps.typing(key);

          const settled = await submission.wait(context).finally(() => {
            clearInterval(typing);
          });

          if (settled.status !== "done") {
            deps.log("warn", "Lane batch was not answered", {
              conversationId: runtime.conversationId,
              detail: "detail" in settled ? settled.detail : undefined,
              reason: "reason" in settled ? settled.reason : undefined,
            });
          }

          await runtime.commit(() => running({ batch: state.batch, phase: "settle" }), context);
        },
        settle: async (current, runtime, context) => {
          const lane = await runtime.snapshot(LaneDoc.token, runtime.conversationId, context);
          await deps.record(lane!.key!, current.state.checkpoint.batch);
          await release(deps, runtime, current.state.checkpoint.batch, context);
        },
      },
      abort: async (_task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const lane = await tx.doc(LaneDoc.token, runtime.conversationId);

          if (lane.runner === runtime.taskId) lane.runner = null;

          return { outcome: { status: "aborted" }, status: "terminal" } as const;
        }, context);
      },
    });
  }

  export interface Admission {
    readonly agent: AgentChange;
    readonly item: LaneDoc.Item;
    readonly key: ConversationKey.Value;
    readonly now: number;
    readonly task: Task<null, State, null, object>;
    readonly timing: LaneDoc.Timing;
    readonly updateId: number;
  }

  // Admits one Telegram message in a single commit: finds or creates the lane conversation,
  // dedups, extends the batching window, and makes sure a lane task will wake for it.
  export async function admit(tx: Tx, admission: Admission): Promise<{ readonly duplicate: boolean }> {
    const index = await tx.doc(LaneDoc.index, ConversationKey.format(admission.key), null);
    const existing = index.conversationId;
    const lane = existing === null ? null : await tx.doc(LaneDoc.token, existing);
    // Table reads must precede the conversation and task writes in one commit.
    const runner = lane?.runner == null ? undefined : await tx.task(lane.runner);
    const sleeper = lane?.sleeper == null ? undefined : await tx.task(lane.sleeper.taskId);
    const conversationId = existing ?? (await createLane(tx, admission.agent));
    index.conversationId = conversationId;
    const draft = lane ?? (await tx.doc(LaneDoc.token, conversationId));
    draft.key = { ...admission.key };

    if (!LaneDoc.admit(draft, admission.item, admission.updateId, admission.now, admission.timing)) {
      return { duplicate: true };
    }

    if (runner?.state.status === "terminal") draft.runner = null;

    if (sleeper?.state.status === "terminal") draft.sleeper = null;

    if (draft.runner !== null || (draft.sleeper !== null && draft.sleeper.until <= draft.wakeAt!)) {
      return { duplicate: false };
    }

    const created = await tx.createTask(admission.task, null, {
      background: true,
      conversationId,
      ownership: { kind: "conversation" },
    });

    draft.sleeper = { taskId: created, until: draft.wakeAt! };

    return { duplicate: false };
  }

  export async function createLane(tx: Tx, agent: AgentChange) {
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, created.id, agent);

    return created.id;
  }

  async function start(deps: Deps, runtime: Runtime, state: Extract<State, { phase: "run" }>, context: Context) {
    const lane = (await runtime.snapshot(LaneDoc.token, runtime.conversationId, context))!;
    const key = lane.key!;
    const chat = await deps.chat(key.chatId);

    if (chat?.isPremium !== true)
      throw new BlockedError({ message: "Chat access is not allowed", reason: "chat-access-revoked" });
    const addressed = state.batch.filter((item) => item.payload.addressed);

    // Silent batches still belong in the transcript, but must not cost a model call.
    if (addressed.length === 0) {
      await deps.record(key, state.batch);
      await runtime.commit(async (tx) => {
        await tx.appendEntry(runtime.conversationId, batchEntry(state.batch, lane));
        LaneDoc.release(await tx.doc(LaneDoc.token, runtime.conversationId), state.batch, runtime.now(), deps.timing);

        return running({ failures: 0, phase: "wait" });
      }, context);

      return;
    }

    const mediaBytes = state.batch
      .flatMap((item) => [...item.payload.repliedMedia, ...item.payload.media])
      .reduce((total, reference) => total + (reference.availability === "stored" ? reference.size : 0), 0);

    if (mediaBytes > MAX_REQUEST_MEDIA_BYTES) {
      throw new BlockedError({
        message: "Prepared request media exceeds the 20 MiB aggregate boundary",
        reason: "oversized-input",
      });
    }

    const precomputed = addressed.flatMap((item) =>
      item.payload.precomputedReaction === undefined
        ? []
        : [{ ...item.payload.precomputedReaction, type: "reaction" as const }],
    );

    if (precomputed.length === addressed.length) {
      await runtime.commit(async (tx) => {
        await tx.appendEntry(runtime.conversationId, batchEntry(state.batch, lane));
        await tx.appendEntry(runtime.conversationId, reactionsEntry(precomputed));

        const delivery = await tx.createTask(
          deps.delivery,
          { actions: precomputed, chatId: key.chatId, prefix: precomputed.length, threadKey: key.threadKey },
          { ownership: { kind: "task", taskId: runtime.taskId } },
        );

        return {
          checkpoint: { batch: state.batch, phase: "settle" },
          on: [delivery],
          policy: "allSettled",
          status: "waiting",
        } as const;
      }, context);

      return;
    }

    // Hashing the checkpointed batch keeps the id stable across retries and reruns, while an
    // edited revision frozen later by this task gets its own submission instead of the old one.
    const requestId = `batch:${runtime.taskId}:${Bun.hash(CanonicalJson.encode(state.batch))}`;

    const view = await runtime.context(runtime.conversationId, context);

    // Only what time erodes is frozen; a rerun of this phase reuses it instead of recalling again.
    const frozen =
      (await runtime.memo<{ contextMemory: string | null; currentDate: string }>(requestId, context)) ??
      (await runtime.memo(
        requestId,
        {
          contextMemory: Reply.memoryCompacted(view.head) ? await deps.recall(key, state.batch) : null,
          currentDate: new Date(runtime.now()).toISOString().slice(0, 10),
        },
        context,
      ));

    const rendered = renderBatch(state.batch, lane);

    await runtime.commit(async (tx) => {
      const run = await tx.doc(Reply.runDoc, runtime.conversationId);
      run.chatTitle = chat.title;
      run.contextMemory = frozen.contextMemory;
      run.currentDate = frozen.currentDate;
      run.marker = rendered[0]!.text;
      run.media = state.batch.flatMap((item, part) =>
        [...item.payload.repliedMedia, ...item.payload.media].flatMap((reference) =>
          reference.availability === "stored" ? [{ part, reference }] : [],
        ),
      );
      run.precomputed = precomputed;
      run.replyLimit = chat.isPrivate ? ChatReply.privateReplyLimit : ChatReply.groupReplyLimit;
      run.research = [];
      run.signOff = Prompt.renderSignOffGuidance(lane.recentReplies);

      return running({ batch: state.batch, phase: "answer", requestId });
    }, context);
  }

  async function release(deps: Deps, runtime: Runtime, batch: readonly LaneDoc.Item[], context: Context) {
    await runtime.commit(async (tx) => {
      LaneDoc.release(await tx.doc(LaneDoc.token, runtime.conversationId), batch, runtime.now(), deps.timing);

      return running({ failures: 0, phase: "wait" });
    }, context);
  }

  function input(batch: readonly LaneDoc.Item[], lane: LaneDoc.Value, requestId: string) {
    return {
      content: renderBatch(batch, lane),
      entry: { data: { messageIds: batch.map((item) => item.payload.messageId) }, kind: BATCH_ENTRY },
      requestId,
      type: "input",
    } as const;
  }

  function renderBatch(batch: readonly LaneDoc.Item[], lane: LaneDoc.Value) {
    const seen = new Set(lane.seenMessageIds);

    return batch.map((item) => ({ text: Prompt.renderLiveMessage(item.payload, seen), type: "text" as const }));
  }

  export function batchEntry(batch: readonly LaneDoc.Item[], lane: LaneDoc.Value): EntryDraft {
    const message: UserMessage = { content: renderBatch(batch, lane), role: "user", timestamp: Date.now() };

    return {
      data: { messageIds: batch.map((item) => item.payload.messageId) },
      kind: BATCH_ENTRY,
      model: [message],
    };
  }

  // Jev reactions answer without a model call; the transcript still records them as ours.
  function reactionsEntry(reactions: readonly TelegramDelivery.ReactionAction[]): EntryDraft {
    const message: AssistantMessage = {
      api: "starlight",
      content: reactions.map((action) => ({ text: Prompt.canonicalEncode({ action }), type: "text" })),
      model: "jev",
      provider: "starlight",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    };

    return { kind: REACTIONS_ENTRY, model: [message] };
  }

  function running(checkpoint: State) {
    return { checkpoint, status: "running" } as const;
  }

  function done() {
    return { outcome: { result: null, status: "completed" }, status: "terminal" } as const;
  }
}

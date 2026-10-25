import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { CompactionEntry } from "@earendil-works/pi-durable";
import type { AgentChange, EntryDraft, EntryId, Harness } from "@earendil-works/pi-durable";
import type { Cause } from "effect";
import { Effect, Schema } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import { Prompt } from "@/context/prompt";
import { ConversationKey } from "@/conversation/key";
import { Lane } from "@/conversation/lane";
import { LaneDoc } from "@/conversation/lane-doc";
import { Reply } from "@/conversation/reply";
import { InputPayloadSchema } from "@/conversation/run-artifacts";
import type { InputPayload } from "@/conversation/run-artifacts";
import { Database } from "@/services/database";

/**
 * One-time import of the previous conversation engine's history, which the Pi migration moved
 * to the `legacy_conversation` schema. Every run that reached the old transcript becomes a batch
 * entry plus, when it researched or answered, a reply entry shaped like a final_output round.
 * The old active context's frozen memory becomes a compaction summary heading the turns that
 * context still held, so each chat continues with what the bot last saw. A lane already in Pi
 * is skipped, so a restart resumes an interrupted import.
 */
export namespace LegacyImport {
  const RUNS_PER_COMMIT = 200;
  const REPLY_ENTRY = "starlight.legacy-reply";

  // Pi's own compaction wrapper (pi-durable harness/compaction.js), so later summaries chain the same way.
  const SUMMARY_PREFIX =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

  const SUMMARY_SUFFIX = "\n</summary>";

  const LegacyLane = Schema.Struct({
    assistantId: Schema.BigInt,
    chatId: Schema.BigInt,
    contextStart: Schema.NullOr(Schema.Int),
    frozenMemory: Schema.NullOr(Schema.String),
    threadKey: Schema.Int,
  });

  const LegacyRun = Schema.Struct({
    actions: Schema.Array(Schema.Struct({ payload: Schema.Unknown, telegramMessageId: Schema.NullOr(Schema.Int) })),
    id: Schema.String,
    inputs: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        payload: InputPayloadSchema,
        senderUserId: Schema.NullOr(Schema.String),
        updateId: Schema.NullOr(Schema.Int),
      }),
    ),
    lastOrdinal: Schema.Int,
    tools: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        error: Schema.NullOr(Schema.String),
        input: Schema.Record(Schema.String, Schema.Json),
        name: Schema.String,
        result: Schema.Json,
      }),
    ),
  });

  type LegacyRun = typeof LegacyRun.Type;

  export interface Options {
    readonly agent: AgentChange;
    readonly timing: LaneDoc.Timing;
  }

  export const run: (
    harness: Harness,
    options: Options,
  ) => Effect.Effect<void, Database.QueryError | Schema.SchemaError | Cause.UnknownError, Database.Service> = Effect.fn(
    "LegacyImport.run",
  )(function* run(harness: Harness, options: Options) {
    const database = yield* Database.Service;

    const lanes = yield* database
      .query(
        async (client) =>
          await client.$queryRaw<unknown[]>`
            SELECT
              lane.assistant_id AS "assistantId",
              lane.chat_id AS "chatId",
              lane.thread_key AS "threadKey",
              context.frozen_memory AS "frozenMemory",
              (
                SELECT MIN(turn.ordinal)
                FROM legacy_conversation.conversation_context_turns AS context_turn
                JOIN legacy_conversation.conversation_transcript_turns AS turn ON turn.id = context_turn.transcript_turn_id
                WHERE context_turn.context_id = context.id
              ) AS "contextStart"
            FROM legacy_conversation.conversation_lanes AS lane
            LEFT JOIN legacy_conversation.conversation_contexts AS context ON context.id = lane.active_context_id
            ORDER BY lane.updated_at DESC
          `,
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyLane))));

    // oxlint-disable-next-line github/array-foreach -- Effect.forEach, not Array.prototype.forEach
    yield* Effect.forEach(
      lanes,
      Effect.fnUntraced(function* importLane(lane) {
        const key = { assistantId: Number(lane.assistantId), chatId: Number(lane.chatId), threadKey: lane.threadKey };

        const index = yield* Effect.tryPromise(
          async () => await harness.snapshot(LaneDoc.index, ConversationKey.format(key), BACKGROUND_CONTEXT),
        );

        if (index?.conversationId != null) return;

        const runs = yield* database
          .query(
            async (client) =>
              await client.$queryRaw<unknown[]>`
              SELECT
                run.id::text AS id,
                MAX(turn.ordinal) AS "lastOrdinal",
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'id', input.id::text,
                    'payload', input.payload,
                    'senderUserId', input.sender_user_id::text,
                    'updateId', input.source_update_id
                  ) ORDER BY run_input.ordinal)
                  FROM legacy_conversation.conversation_run_inputs AS run_input
                  JOIN legacy_conversation.conversation_inputs AS input ON input.id = run_input.input_id
                  WHERE run_input.run_id = run.id
                ), '[]') AS inputs,
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'payload', action.payload,
                    'telegramMessageId', action.telegram_message_id
                  ) ORDER BY action.ordinal)
                  FROM legacy_conversation.conversation_run_actions AS action
                  WHERE action.run_id = run.id AND action.delivery_status = 'delivered'
                ), '[]') AS actions,
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'callId', tool.provider_call_id,
                    'error', tool.error_message,
                    'input', tool.input,
                    'name', tool.tool_name,
                    'result', tool.result
                  ) ORDER BY tool.created_at)
                  FROM legacy_conversation.conversation_tool_calls AS tool
                  WHERE tool.run_id = run.id
                ), '[]') AS tools
              FROM legacy_conversation.conversation_runs AS run
              JOIN legacy_conversation.conversation_transcript_turns AS turn ON turn.run_id = run.id
              WHERE run.assistant_id = ${lane.assistantId}
                AND run.chat_id = ${lane.chatId}
                AND run.thread_key = ${lane.threadKey}
              GROUP BY run.id
              ORDER BY MIN(turn.ordinal)
            `,
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyRun))));

        // A lane whose only batch was blocked never reached the old transcript; there is nothing to keep.
        if (runs.length === 0) return;

        const summary =
          lane.frozenMemory === null || lane.frozenMemory === Prompt.renderMemory({ checkpoint: "", scopes: [] })
            ? null
            : lane.frozenMemory;

        yield* Effect.tryPromise(async () => {
          await restore(harness, key, runs, summary, lane.contextStart, options);
        });

        yield* Effect.logInfo("Legacy conversation imported").pipe(
          Effect.annotateLogs({
            conversationKey: ConversationKey.format(key),
            runs: runs.length,
            summary: summary !== null,
          }),
        );
      }),
      { discard: true },
    );
  });

  async function restore(
    harness: Harness,
    key: ConversationKey.Value,
    runs: readonly LegacyRun[],
    summary: string | null,
    contextStart: number | null,
    options: Options,
  ) {
    // Replays the live lane flow on a detached document, so the windows (dedup keys, recent
    // exchange, seen ids, sign-off replies) end where live traffic would have left them.
    const lane = { ...LaneDoc.empty(), key };
    const now = Date.now();

    const history = runs.map((legacy) => {
      const batch = legacy.inputs.map((input) => ({
        payload: input.payload as InputPayload,
        senderUserId: input.senderUserId,
      }));

      const actions = legacy.actions.map((action) => ({
        action: ChatReply.actionSchema.parse(action.payload),
        telegramMessageId: action.telegramMessageId,
      }));

      for (const [index, input] of legacy.inputs.entries()) {
        LaneDoc.admit(lane, batch[index]!, input.updateId ?? -Number(input.id), now, options.timing);
      }

      lane.pending = [];

      const entries = [Lane.batchEntry(batch, lane), ...replyEntries(legacy, actions)];

      LaneDoc.release(lane, batch, now, options.timing);

      for (const delivered of actions) {
        if (delivered.action.type === "text" && delivered.telegramMessageId !== null) {
          LaneDoc.rememberReply(lane, delivered.action, delivered.telegramMessageId);
        }
      }

      return { entries, lastOrdinal: legacy.lastOrdinal };
    });

    const conversationId = await harness.commit(
      async (tx) => await Lane.createLane(tx, options.agent),
      BACKGROUND_CONTEXT,
    );

    const firstEntries: EntryId[] = [];

    for (let start = 0; start < history.length; start += RUNS_PER_COMMIT) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- one lane's chunks append in order
      const appended = await harness.commit(async (tx) => {
        const ids: EntryId[] = [];

        for (const item of history.slice(start, start + RUNS_PER_COMMIT)) {
          for (const [position, entry] of item.entries.entries()) {
            // oxlint-disable-next-line react-doctor/async-await-in-loop -- entries append in transcript order
            const { id } = await tx.appendEntry(conversationId, entry);

            if (position === 0) ids.push(id);
          }
        }

        return ids;
      }, BACKGROUND_CONTEXT);

      firstEntries.push(...appended);
    }

    // The old context started at contextStart; without one it held only its frozen memory.
    const kept = contextStart === null ? -1 : history.findIndex((item) => item.lastOrdinal >= contextStart);

    await harness.commit(async (tx) => {
      const [index, draft] = await Promise.all([
        tx.doc(LaneDoc.index, ConversationKey.format(key), null),
        tx.doc(LaneDoc.token, conversationId),
      ]);

      if (summary !== null)
        await tx.appendEntry(conversationId, compactionEntry(summary, firstEntries[kept] ?? "self"));
      Object.assign(draft, lane);
      index.conversationId = conversationId;
    }, BACKGROUND_CONTEXT);
  }

  // Research rounds and delivered actions, in the shape a live run leaves: tool calls with their
  // results, then one final_output call whose result reports what was delivered.
  function replyEntries(
    legacy: LegacyRun,
    actions: readonly {
      readonly action: ChatReply.Response["replies"][number];
      readonly telegramMessageId: number | null;
    }[],
  ): EntryDraft[] {
    const finalCallId = `legacy-${legacy.id}`;

    const research: Message[] =
      legacy.tools.length === 0
        ? []
        : [
            assistant(
              legacy.tools.map((tool) => ({
                arguments: tool.input,
                id: tool.callId,
                name: tool.name,
                type: "toolCall",
              })),
            ),
            ...legacy.tools.map((tool) => ({
              content: [{ text: tool.error ?? JSON.stringify(tool.result), type: "text" as const }],
              isError: tool.error !== null,
              role: "toolResult" as const,
              timestamp: Date.now(),
              toolCallId: tool.callId,
              toolName: tool.name,
            })),
          ];

    const answer: Message[] =
      actions.length === 0
        ? []
        : [
            assistant([
              {
                arguments: { replies: actions.map((delivered) => delivered.action) },
                id: finalCallId,
                name: Reply.FINAL_OUTPUT,
                type: "toolCall",
              },
            ]),
            {
              content: [
                {
                  text: Prompt.canonicalEncode(
                    actions.map((delivered) => ({
                      action: delivered.action,
                      delivery: { error: null, status: "delivered", telegramMessageId: delivered.telegramMessageId },
                    })),
                  ),
                  type: "text",
                },
              ],
              isError: false,
              role: "toolResult",
              timestamp: Date.now(),
              toolCallId: finalCallId,
              toolName: Reply.FINAL_OUTPUT,
            },
          ];

    const model = [...research, ...answer];

    return model.length === 0 ? [] : [{ kind: REPLY_ENTRY, model }];
  }

  function assistant(content: ToolCall[]): AssistantMessage {
    return {
      api: "starlight",
      content,
      model: "legacy",
      provider: "starlight",
      role: "assistant",
      stopReason: "toolUse",
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
  }

  function compactionEntry(summary: string, head: EntryId | "self"): EntryDraft {
    return {
      data: { reason: "threshold" },
      head,
      kind: CompactionEntry.kind,
      model: [
        {
          content: [{ text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
      ],
    };
  }
}

import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { ConversationId, JsonObject, TaskId } from "@earendil-works/pi-durable";
import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import { CanonicalJson } from "@/context/canonical-json";
import type { ConversationKey } from "@/conversation/key";
import type { InputPayload } from "@/conversation/run-artifacts";

/**
 * Durable lane state, one document per Telegram lane conversation. Admission and the lane
 * task change it in Pi commits, which are serialized, so the read-modify-write here needs no
 * locks. It holds the batching window and the small amount of history the next prompt needs.
 */
export namespace LaneDoc {
  const MAX_BATCH_MESSAGES = 20;
  const MAX_ALBUM_MESSAGES = 10;
  const ALBUM_SETTLE_MS = 35_000;
  const ADMITTED_KEY_WINDOW = 256;
  const SEEN_MESSAGE_WINDOW = 500;
  const RECENT_WINDOW = 32;
  export const SIGN_OFF_WINDOW = 8;

  export interface Item {
    readonly payload: InputPayload;
    readonly senderUserId: string | null;
    // Propagation carrier of the admitting Telegram update.
    readonly trace?: TelemetryCarrier;
  }

  // One line of the recent exchange that dialogue continuation judges participation against.
  export interface Recent extends JsonObject {
    messageId: number;
    repliedText: string | null;
    replyToMessageId: number | null;
    speaker: string;
    speakerId: string;
    text: string;
  }

  export interface Value {
    // Dedup window over Telegram update ids and message revisions.
    admittedKeys: string[];
    firstPendingAt: number | null;
    key: ConversationKey.Value | null;
    pending: Item[];
    recent: Recent[];
    recentReplies: string[];
    // The lane task that froze the current batch; it keeps the claim through its successor wait.
    runner: TaskId | null;
    // Message ids already in the transcript; reply targets among them are referenced, not quoted.
    seenMessageIds: number[];
    // The newest idle-lane task sleeping toward wakeAt. A sleeping task cannot be re-armed, so an
    // admission that moves wakeAt earlier starts another sleeper; whichever wakes first claims.
    sleeper: { taskId: TaskId; until: number } | null;
    wakeAt: number | null;
  }

  export type Draft = Value;

  export interface Timing {
    readonly maxWaitMs: number;
    readonly quietMs: number;
  }

  export const token = defineDoc<Value & JsonObject>({
    kind: "starlight.lane",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: empty,
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
  });

  // Session-wide index from a lane key to its conversation.
  export const index = defineDocFamily<{ conversationId: ConversationId | null }, null>({
    kind: "starlight.lane-index",
    version: 1,
    family: true,
    scope: "session",
    initial: () => ({ conversationId: null }),
    checkpointWhen: () => true,
  });

  export function empty(): Value & JsonObject {
    return {
      admittedKeys: [],
      firstPendingAt: null,
      key: null,
      pending: [],
      recent: [],
      recentReplies: [],
      runner: null,
      seenMessageIds: [],
      sleeper: null,
      wakeAt: null,
    };
  }

  // Returns false for a duplicate update or an unchanged message revision.
  export function admit(lane: Draft, item: Item, updateId: number, now: number, timing: Timing): boolean {
    const { payload } = item;
    const revision = `${payload.messageId}:${payload.editDate ?? "original"}:${Bun.hash(CanonicalJson.encode(payload))}`;
    const keys = [`update:${updateId}`, `message:${revision}`];

    if (keys.some((key) => lane.admittedKeys.includes(key))) return false;

    const album = payload.mediaGroupId !== null;
    const quietMs = album ? ALBUM_SETTLE_MS : timing.quietMs;
    const maxWaitMs = album ? ALBUM_SETTLE_MS : timing.maxWaitMs;
    const firstPendingAt = lane.firstPendingAt ?? now;

    lane.admittedKeys = [...lane.admittedKeys, ...keys].slice(-ADMITTED_KEY_WINDOW);
    lane.pending.push(item);
    remember(lane, {
      messageId: payload.messageId,
      repliedText: payload.repliedText,
      replyToMessageId: payload.replyToMessageId,
      speaker: payload.senderFirstName,
      speakerId: payload.senderId?.toString() ?? "unknown",
      text: payload.text || "[non-text message]",
    });
    lane.firstPendingAt = firstPendingAt;
    lane.wakeAt = Math.min(now + quietMs, firstPendingAt + maxWaitMs);

    return true;
  }

  // Freezes the next batch: up to 20 messages, extended to the end of an album that the 20th
  // message belongs to so an album is never split across runs.
  export function freeze(lane: Draft): Item[] {
    const candidates = lane.pending.slice(0, MAX_BATCH_MESSAGES + MAX_ALBUM_MESSAGES);
    const finalGroup = candidates.at(MAX_BATCH_MESSAGES - 1)?.payload.mediaGroupId ?? null;

    const albumEnd = candidates
      .slice(MAX_BATCH_MESSAGES)
      .findIndex((item) => finalGroup === null || item.payload.mediaGroupId !== finalGroup);

    const size = albumEnd === -1 ? candidates.length : MAX_BATCH_MESSAGES + albumEnd;
    const batch = lane.pending.slice(0, Math.min(size, lane.pending.length));
    lane.pending = lane.pending.slice(batch.length);

    return batch;
  }

  // After a run, later input waits one quiet window so the next batch can gather.
  export function release(lane: Draft, batch: readonly Item[], now: number, timing: Timing) {
    lane.seenMessageIds = [
      ...lane.seenMessageIds,
      ...batch.flatMap((item) =>
        item.payload.replyToMessageId === null || item.payload.repliedText === null
          ? [item.payload.messageId]
          : [item.payload.replyToMessageId, item.payload.messageId],
      ),
    ].slice(-SEEN_MESSAGE_WINDOW);
    lane.firstPendingAt = lane.pending.length === 0 ? null : now;
    lane.wakeAt = lane.pending.length === 0 ? null : now + Math.min(timing.quietMs, timing.maxWaitMs);
  }

  export function rememberReply(
    lane: Draft,
    reply: { readonly replyTo?: number | null; readonly text: string },
    telegramMessageId: number,
  ) {
    lane.recentReplies = [...lane.recentReplies, reply.text].slice(-SIGN_OFF_WINDOW);
    lane.seenMessageIds = [...lane.seenMessageIds, telegramMessageId].slice(-SEEN_MESSAGE_WINDOW);
    remember(lane, {
      messageId: telegramMessageId,
      repliedText: null,
      replyToMessageId: reply.replyTo ?? null,
      speaker: "Starlight",
      speakerId: lane.key!.assistantId.toString(),
      text: reply.text,
    });
  }

  // An edit replaces the earlier revision of the same message.
  function remember(lane: Draft, message: Recent) {
    lane.recent = [...lane.recent.filter((item) => item.messageId !== message.messageId), message]
      .toSorted((left, right) => left.messageId - right.messageId)
      .slice(-RECENT_WINDOW);
  }
}

import * as ChatReply from "@/ai/chat-reply";
import { selected } from "@/ai/model-profile";
import type { ConversationContextRole, Prisma } from "@starlight/utils/generated/prisma/client";
import { Schema } from "effect";

export const renderVersion = "conversation-context-v1";
export const FrozenEnvelope = Schema.fromJsonString(
  Schema.Struct({
    instructions: Schema.String,
    tools: Schema.Array(Schema.String),
  }),
);

export interface EnvelopeInput {
  readonly webLookupEnabled: boolean;
}

export interface RenderedTurn {
  readonly content: string;
  readonly role: ConversationContextRole;
}

export interface LiveMessagePayload {
  readonly forwardOrigin: string | null;
  readonly messageId: number;
  readonly repliedText: string | null;
  readonly replyToMessageId: number | null;
  readonly senderFirstName: string;
  readonly text: string;
}

export interface Segment {
  readonly estimatedTokens: number;
  readonly rollingPrefixHash: string;
  readonly segmentHash: string;
}

export function renderEnvelope(input: EnvelopeInput): string {
  return canonicalEncode({
    cacheStrategy: "explicit-fixed-base",
    instructions: ChatReply.systemPrompt,
    mediaStrategy: "stable-metadata-v1",
    model: selected.model,
    outputSchemaVersion: ChatReply.outputSchemaVersion,
    reasoning: selected.reasoning,
    renderVersion,
    route: selected.route,
    tools: input.webLookupEnabled ? [ChatReply.toolsetVersion] : [],
  });
}

export function profileFingerprint(webLookupEnabled: boolean): string {
  return new Bun.CryptoHasher("sha256").update(renderEnvelope({ webLookupEnabled })).digest("hex");
}

export function renderMemory(memory: string): string {
  return canonicalEncode({
    label: "Frozen conversation memory",
    text: memory,
    trust: "untrusted-conversation-data",
  });
}

export function renderTurn(turn: RenderedTurn): string {
  return canonicalEncode({ role: turn.role, content: turn.content });
}

// Reply targets resolve against sealed transcript turns when available; live batches have
// no sealed history yet, so their targets quote the captured replied text instead.
export function describeReplyTarget(
  payload: LiveMessagePayload,
  knownMessageIds?: ReadonlySet<number>,
): (replyToMessageId: number) => string {
  return (replyToMessageId) => {
    if (knownMessageIds?.has(replyToMessageId)) return `REPLIES TO MESSAGE #${replyToMessageId}\n`;
    if (payload.repliedText) return `REPLIED MESSAGE #${replyToMessageId}: ${payload.repliedText}\n`;
    return `REPLIED MESSAGE #${replyToMessageId}: [target unavailable]\n`;
  };
}

export function renderLiveMessage(
  payload: LiveMessagePayload,
  resolveTarget: (replyToMessageId: number) => string,
): string {
  const forwardOrigin = payload.forwardOrigin === null ? "" : `FORWARD ORIGIN: ${payload.forwardOrigin}\n`;
  const reply = payload.replyToMessageId === null ? "" : resolveTarget(payload.replyToMessageId);
  return `${forwardOrigin}${reply}LIVE MESSAGE #${payload.messageId} from ${payload.senderFirstName}: ${payload.text}`;
}

export function extendPrefix(previousHash: string, renderedTurn: string): Segment {
  const segmentHash = new Bun.CryptoHasher("sha256").update(renderedTurn).digest("hex");
  return {
    estimatedTokens: Math.ceil(renderedTurn.length / 4),
    rollingPrefixHash: new Bun.CryptoHasher("sha256").update(`${previousHash}:${segmentHash}`).digest("hex"),
    segmentHash,
  };
}

// Stored Prisma Json columns are typed `unknown`; every value written here was
// JSON-serialized, so the boundary casts once before structural canonicalization.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- raw Json column values are the domain input
export function canonicalEncode(value: unknown): string {
  return JSON.stringify(canonicalize(value as Prisma.InputJsonValue));
}

function canonicalize(value: Prisma.InputJsonValue): Prisma.InputJsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .toSorted((left, right) => left[0].localeCompare(right[0]))
      .map((entry) => [entry[0], canonicalize(entry[1])]),
  );
}

export function verifyPrefix(
  basePrefixHash: string,
  turns: readonly {
    readonly renderedContent: string;
    readonly rollingPrefixHash: string;
    readonly segmentHash: string;
  }[],
): string {
  let rollingHash = basePrefixHash;
  for (const turn of turns) {
    const segment = extendPrefix(rollingHash, turn.renderedContent);
    if (segment.segmentHash !== turn.segmentHash || segment.rollingPrefixHash !== turn.rollingPrefixHash) {
      throw new Error("Context prefix chain is invalid");
    }
    rollingHash = segment.rollingPrefixHash;
  }
  return rollingHash;
}

// The seed fields derive the context base from the frozen envelope and memory;
// both creation paths must produce byte-identical values or the two chains diverge.
export function stableSeed(envelope: string, memory: string) {
  return {
    basePrefixHash: new Bun.CryptoHasher("sha256")
      .update(`${envelope.length}:${envelope}${memory.length}:${memory}`)
      .digest("hex"),
    estimatedStableTokens: Math.ceil(envelope.length / 4) + Math.ceil(memory.length / 4),
    frozenMemory: memory,
    frozenMemoryHash: new Bun.CryptoHasher("sha256").update(memory).digest("hex"),
    stableEnvelope: envelope,
    stableEnvelopeHash: new Bun.CryptoHasher("sha256").update(envelope).digest("hex"),
  };
}

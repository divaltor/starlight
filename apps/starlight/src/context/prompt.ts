import { ChatReply } from "@/ai/chat-reply";
import type { ChatTools } from "@/ai/chat-tools";
import { selected } from "@/ai/model-profile";
import type { ConversationContextRole } from "@starlight/utils/generated/prisma/client";
import { Schema } from "effect";
import { CanonicalJson } from "@/context/canonical-json";
import type { Media } from "@/media/media";

export namespace Prompt {
  export const renderVersion = "conversation-context-v2";
  export const canonicalEncode = CanonicalJson.encode;
  export const FrozenEnvelope = Schema.fromJsonString(
    Schema.Struct({
      instructions: Schema.String,
      tools: Schema.Array(Schema.String),
    }),
  );

  export interface EnvelopeInput {
    readonly toolProfile: ChatTools.Profile;
  }

  export interface RenderedTurn {
    readonly content: string;
    readonly role: ConversationContextRole;
  }

  export interface LiveMessagePayload {
    readonly forwardOrigin: string | null;
    readonly messageId: number;
    readonly media: readonly Media.Reference[];
    readonly repliedText: string | null;
    readonly replyToMessageId: number | null;
    readonly repliedMedia: readonly Media.Reference[];
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
      mediaStrategy: "stable-metadata-v2-live-bytes",
      model: selected.model,
      outputSchemaVersion: ChatReply.outputSchemaVersion,
      reasoning: selected.reasoning,
      renderVersion,
      route: selected.route,
      tools: input.toolProfile,
    });
  }

  export function profileFingerprint(toolProfile: ChatTools.Profile): string {
    return new Bun.CryptoHasher("sha256").update(renderEnvelope({ toolProfile })).digest("hex");
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
    const repliedMedia = payload.repliedMedia.map((reference) => reference.stableDescription).join("\n");
    const media = payload.media.map((reference) => reference.stableDescription).join("\n");
    const repliedMediaBlock = repliedMedia ? `REPLIED MEDIA:\n${repliedMedia}\n` : "";
    const mediaBlock = media ? `\nMEDIA:\n${media}` : "";
    return `${forwardOrigin}${reply}${repliedMediaBlock}LIVE MESSAGE #${payload.messageId} from ${
      payload.senderFirstName
    }: ${payload.text}${mediaBlock}`;
  }

  export function extendPrefix(previousHash: string, renderedTurn: string): Segment {
    const segmentHash = new Bun.CryptoHasher("sha256").update(renderedTurn).digest("hex");
    return {
      estimatedTokens: Math.ceil(renderedTurn.length / 4),
      rollingPrefixHash: new Bun.CryptoHasher("sha256").update(`${previousHash}:${segmentHash}`).digest("hex"),
      segmentHash,
    };
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
}

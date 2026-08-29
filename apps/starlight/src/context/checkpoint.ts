import type { ConversationCheckpointReason, Prisma } from "@starlight/utils/generated/prisma/client";
import { z } from "zod";

export namespace Checkpoint {
  const PROFILE_RETAINED_RUN_LIMIT = 8;
  export const summaryInstructions = `Summarize only the active conversation continuity needed after old turns are removed.
Preserve unresolved user intent, constraints and referents, corrections, assistant commitments, open questions, and tool or media facts needed for unfinished work.
Omit durable profile facts, trivia, resolved topics, obsolete intermediate wording, and repeated greetings unless they are necessary to understand active state. Long-term memory supplies durable facts separately.
Return only the summary body. Do not include frozen-memory headings or wrapper text. Do not invent facts.`;

  // Contract for the summarizer output persisted on checkpoint attempts.
  export const Summary = z.object({ summary: z.string().min(1) });

  // A parent-context turn sealed with its transcript source; boundary math needs only
  // ordinals, token estimates, and run grouping.
  export type SealedTurn = Prisma.ConversationContextTurnGetPayload<{ include: { transcriptTurn: true } }>;

  // Fields republished from parent turns onto the child context after a commit.
  export type TailTurn = Pick<SealedTurn, "renderedContent" | "renderVersion" | "role" | "transcriptTurnId">;

  // Attempt columns that freeze a boundary between attempts.
  export type Attempt = Pick<
    Prisma.ConversationCheckpointAttemptGetPayload<object>,
    "headEndTurnOrdinal" | "retainedStartTurnOrdinal"
  >;

  // Splits sealed context turns into a summarized head and a retained tail. Turns are
  // grouped into run units so a conversation is never cut mid-run; the oldest unit always
  // stays in the head, and the tail grows newest-first until it reaches the token target.
  export function selectBoundary(
    turns: readonly SealedTurn[],
    retainedTokenTarget: number,
  ): { readonly head: SealedTurn[]; readonly tail: SealedTurn[] } | null {
    const units: { runId: string; start: number; tokens: number }[] = [];
    for (const [index, turn] of turns.entries()) {
      const current = units.at(-1);
      if (current?.runId === turn.transcriptTurn.runId) {
        current.tokens += turn.estimatedTokens;
        continue;
      }
      units.push({ runId: turn.transcriptTurn.runId, start: index, tokens: turn.estimatedTokens });
    }
    if (units.length < 2) return null;

    let retainedTokens = 0;
    let tailStart = turns.length;
    for (const unit of units.slice(1).toReversed()) {
      if (retainedTokens >= retainedTokenTarget) break;
      tailStart = unit.start;
      retainedTokens += unit.tokens;
    }
    return { head: turns.slice(0, tailStart), tail: turns.slice(tailStart) };
  }

  export function selectProfileBoundary(
    turns: readonly SealedTurn[],
    retainedTokenTarget: number,
  ): { readonly head: SealedTurn[]; readonly tail: SealedTurn[] } {
    const units: { runId: string; start: number; tokens: number }[] = [];
    for (const [index, turn] of turns.entries()) {
      const current = units.at(-1);
      // oxlint-disable-next-line prefer-destructuring -- project style keeps property access explicit
      const runId = turn.transcriptTurn.runId;
      if (current?.runId === runId) {
        current.tokens += turn.estimatedTokens;
      }
      if (current?.runId !== runId) {
        units.push({ runId, start: index, tokens: turn.estimatedTokens });
      }
    }

    let retainedRuns = 0;
    let retainedTokens = 0;
    let tailStart = turns.length;
    for (const unit of units.toReversed()) {
      if (
        retainedRuns >= PROFILE_RETAINED_RUN_LIMIT ||
        (retainedRuns > 0 && retainedTokens + unit.tokens > retainedTokenTarget)
      ) {
        break;
      }
      tailStart = unit.start;
      retainedRuns += 1;
      retainedTokens += unit.tokens;
    }
    return { head: turns.slice(0, tailStart), tail: turns.slice(tailStart) };
  }

  // Retries resolve against the ordinals sealed on the existing attempt instead of
  // re-selecting, so every attempt summarizes the exact same head input.
  export function resolveBoundary(
    turns: readonly SealedTurn[],
    existing: Attempt | null,
    retainedTokenTarget: number,
    reason: ConversationCheckpointReason,
  ): { readonly head: SealedTurn[]; readonly tail: SealedTurn[] } | null {
    if (!existing) {
      return reason === "profileChange"
        ? selectProfileBoundary(turns, retainedTokenTarget)
        : selectBoundary(turns, retainedTokenTarget);
    }
    const retainedStart = existing.retainedStartTurnOrdinal;
    return {
      head: turns.filter((turn) => turn.transcriptTurn.ordinal <= existing.headEndTurnOrdinal),
      tail: retainedStart === null ? [] : turns.filter((turn) => turn.transcriptTurn.ordinal >= retainedStart),
    };
  }
}

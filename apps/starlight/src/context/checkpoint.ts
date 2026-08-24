import { z } from "zod";

export const summaryInstructions = `Summarize the conversation history for future continuity.
Preserve speaker attribution, current decisions, corrections, open questions, tool-derived facts, media facts, and unfinished work.
Remove obsolete intermediate wording and repeated greetings. Do not invent facts.`;

// Contract for the summarizer output persisted on checkpoint attempts.
export const Summary = z.object({ summary: z.string().min(1) });

// Splits sealed context turns into a summarized head and a retained tail. Turns are
// grouped into run units so a conversation is never cut mid-run; the oldest unit always
// stays in the head, and the tail grows newest-first until it reaches the token target.
export function selectBoundary<
  Turn extends {
    readonly estimatedTokens: number;
    readonly transcriptTurn: { readonly ordinal: number; readonly runId: string };
  },
>(turns: readonly Turn[], retainedTokenTarget: number): { readonly head: Turn[]; readonly tail: Turn[] } | null {
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

// Retries resolve against the ordinals sealed on the existing attempt instead of
// re-selecting, so every attempt summarizes the exact same head input.
export function resolveBoundary<
  Turn extends {
    readonly estimatedTokens: number;
    readonly transcriptTurn: { readonly ordinal: number; readonly runId: string };
  },
>(
  turns: readonly Turn[],
  existing: {
    readonly headEndTurnOrdinal: number;
    readonly retainedStartTurnOrdinal: number | null;
  } | null,
  retainedTokenTarget: number,
): { readonly head: Turn[]; readonly tail: Turn[] } | null {
  if (!existing) return selectBoundary(turns, retainedTokenTarget);
  const retainedStart = existing.retainedStartTurnOrdinal;
  return {
    head: turns.filter((turn) => turn.transcriptTurn.ordinal <= existing.headEndTurnOrdinal),
    tail: retainedStart === null ? [] : turns.filter((turn) => turn.transcriptTurn.ordinal >= retainedStart),
  };
}

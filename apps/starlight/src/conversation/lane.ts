import type { Prisma } from "@starlight/utils/generated/prisma/client";

export namespace Lane {
  export type LaneKey = Pick<Prisma.ConversationLaneGetPayload<object>, "assistantId" | "chatId" | "threadKey">;

  // Every lane mutation serializes on this row lock for the duration of its transaction;
  // holding it is what keeps revisions, fences, and context publication linear per thread.
  // Returns the row state read under the lock so callers never act on a pre-lock snapshot.
  export async function lockLane(
    transaction: Prisma.TransactionClient,
    key: LaneKey,
  ): Promise<{ readonly activeRunId: string | null }> {
    const rows = await transaction.$queryRaw<{ readonly active_run_id: string | null }[]>`
			SELECT active_run_id FROM conversation_lanes
			WHERE assistant_id = ${key.assistantId}
				AND chat_id = ${key.chatId}
				AND thread_key = ${key.threadKey}
			FOR UPDATE
		`;
    return { activeRunId: rows[0]!.active_run_id };
  }

  // Rejects work whose claim was superseded by a newer fenced claim (different active run or
  // a higher fencing token). Locks first so the check and the writes after it are atomic.
  export async function assertFence(
    transaction: Prisma.TransactionClient,
    key: LaneKey,
    claim: { readonly fencingToken: bigint; readonly runId: string },
  ) {
    await lockLane(transaction, key);
    const lane = await transaction.conversationLane.findUniqueOrThrow({
      where: { assistantId_chatId_threadKey: key },
      select: { activeRunId: true, fencingToken: true },
    });
    if (lane.activeRunId !== claim.runId || lane.fencingToken !== claim.fencingToken) {
      throw new Error("Conversation lane fence is stale");
    }
  }
}

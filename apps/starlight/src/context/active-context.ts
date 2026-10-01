import type { Prisma } from "@starlight/utils/generated/prisma/client";
import { Prompt } from "@/context/prompt";
import { ConversationKey } from "@/conversation/key";
import type { Lane } from "@/conversation/lane";

export namespace ActiveContext {
  export async function ensure(
    transaction: Prisma.TransactionClient,
    key: Lane.LaneKey,
    frozenMemory: string,
    stableEnvelope: string,
  ) {
    const existing = await transaction.conversationContext.findFirst({
      where: { ...key, status: "active" },
    });
    if (existing) return existing;

    // One Prisma transaction connection must execute its queries serially.
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await
    const latest = await transaction.conversationContext.aggregate({
      where: key,
      _max: { generation: true },
    });
    const created = await transaction.conversationContext.create({
      data: {
        ...key,
        activeKey: ConversationKey.format(key),
        generation: (latest._max.generation ?? 0) + 1,
        modelProfileFingerprint: new Bun.CryptoHasher("sha256").update(stableEnvelope).digest("hex"),
        ...Prompt.stableSeed(stableEnvelope, frozenMemory),
      },
    });
    await transaction.conversationLane.update({
      where: { assistantId_chatId_threadKey: key },
      data: { activeContextId: created.id },
    });
    return created;
  }
}

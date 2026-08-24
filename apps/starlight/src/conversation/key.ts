import { Schema } from "effect";

export namespace ConversationKey {
  export const Value = Schema.Struct({
    assistantId: Schema.Int,
    chatId: Schema.Int,
    threadKey: Schema.Int,
  });

  export type Value = typeof Value.Type;

  // Interpolation renders bigint and number identically, so one formatter serves both the
  // app-side Value and Prisma's BigInt identity columns.
  export function format(key: {
    readonly assistantId: bigint | number;
    readonly chatId: bigint | number;
    readonly threadKey: number;
  }): string {
    return `v1/${key.assistantId}/${key.chatId}/${key.threadKey}`;
  }

  // Prisma stores the lane identity columns as BigInt; convert once here instead of
  // re-deriving the shape at every query builder.
  export function toDb(key: Value) {
    return {
      assistantId: BigInt(key.assistantId),
      chatId: BigInt(key.chatId),
      threadKey: key.threadKey,
    };
  }

  // Sole remaining use: BullMQ job payloads are JSON, so BigInt rows must become numbers.
  export function fromDb(row: {
    readonly assistantId: bigint;
    readonly chatId: bigint;
    readonly threadKey: number;
  }): Value {
    return {
      assistantId: Number(row.assistantId),
      chatId: Number(row.chatId),
      threadKey: row.threadKey,
    };
  }

  export async function affinity(key: Value, secret: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(format(key)));

    return Buffer.from(signature).toString("hex").slice(0, 32);
  }
}

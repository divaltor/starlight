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

  export type Db = ReturnType<typeof toDb>;

  // Prisma stores the lane identity columns as BigInt; convert once here instead of
  // re-deriving the shape at every query builder.
  export function toDb(key: Value) {
    return {
      assistantId: BigInt(key.assistantId),
      chatId: BigInt(key.chatId),
      threadKey: key.threadKey,
    };
  }
}

import type { Message } from "grammy/types";

const QUOTLY_COMMAND = /^\/q(?:@[a-z\d_]+)?(?:\s|$)/iu;

export namespace MessageReply {
  // Every plain (non-reply) message inside a forum topic arrives with
  // reply_to_message pointing at the topic-created service message, so only a
  // reply to a real user message counts as a reply.
  export function actualReply(message: Message): Message | undefined {
    const replied = message.reply_to_message;
    return replied?.forum_topic_created === undefined ? replied : undefined;
  }

  export interface Options {
    readonly explicitlyAddressed: boolean;
    readonly hasSticker: boolean;
    readonly isReply: boolean;
    readonly random: () => number;
    readonly randomResponseChance: number;
    readonly text: string;
  }

  export function shouldRespond(options: Options): boolean {
    if (options.isReply && QUOTLY_COMMAND.test(options.text)) return false;
    if (options.explicitlyAddressed) return true;
    if (options.hasSticker) return false;
    return options.random() < options.randomResponseChance;
  }
}

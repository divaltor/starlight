import type { Message } from "grammy/types";

const QUOTLY_COMMAND = /^\/q(?:@[a-z\d_]+)?(?:\s|$)/iu;
// \b is ASCII-only, so it never bounds Cyrillic words; use explicit letter lookarounds.
const BOT_NAME_PATTERN = /(?<![\p{L}\p{N}_])(?:старка|зв[её]здочка)(?![\p{L}\p{N}_])/iu;

export namespace MessageReply {
  // Every plain (non-reply) message inside a forum topic arrives with
  // reply_to_message pointing at the topic-created service message, so only a
  // reply to a real user message counts as a reply.
  export function actualReply(message: Message): Message | undefined {
    const replied = message.reply_to_message;
    return replied?.forum_topic_created === undefined ? replied : undefined;
  }

  export interface AddressedOptions {
    readonly botId: number;
    readonly botUsername: string | undefined;
    readonly message: Message;
  }

  export function isAddressedToBot(options: AddressedOptions): boolean {
    // Forwarded content is authored by the original sender, not the forwarder,
    // so neither a mention inside it nor its original reply context counts as
    // an explicit address from this chat.
    if (options.message.forward_origin !== undefined) return false;
    if (actualReply(options.message)?.from?.id === options.botId) return true;
    const text = options.message.text ?? options.message.caption ?? "";
    return (
      Boolean(options.botUsername && text.toLowerCase().includes(`@${options.botUsername.toLowerCase()}`)) ||
      BOT_NAME_PATTERN.test(text)
    );
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

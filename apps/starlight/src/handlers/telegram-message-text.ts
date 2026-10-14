import type { Message } from "grammy/types";

export namespace TelegramMessageText {
  // Poll shape stays structural: callers pass the full Telegram poll, tests pass
  // question with options only.
  export interface PollText {
    readonly options: readonly { readonly text: string }[];
    readonly question: string;
  }

  export function withEntityLinks(
    message:
      | (Pick<Message, "caption" | "caption_entities" | "entities" | "text"> & { readonly poll?: PollText })
      | undefined,
  ): string | null {
    const text = message?.text ?? message?.caption ?? describePoll(message?.poll);

    if (text === undefined) return null;
    const entities = message?.text === undefined ? message?.caption_entities : message?.entities;

    const links = new Set<string>();

    for (const entity of entities ?? []) {
      const textLink = entity.type === "text_link" ? entity.url : null;
      const link = entity.type === "url" ? text.slice(entity.offset, entity.offset + entity.length) : textLink;

      if (link !== null && !text.includes(link)) links.add(link);
    }

    return links.size === 0 ? text : `${text}\nLINKS:\n${[...links].join("\n")}`;
  }

  // Polls arrive without text or caption; render question with options so
  // admission keeps them as plain context instead of dropping them silently.
  function describePoll(poll: PollText | undefined): string | undefined {
    if (!poll) return undefined;

    if (poll.options.length === 0) return `POLL: ${poll.question}`;
    const options = poll.options.map((option) => `- ${option.text}`).join("\n");

    return `POLL: ${poll.question}\nOPTIONS:\n${options}`;
  }
}

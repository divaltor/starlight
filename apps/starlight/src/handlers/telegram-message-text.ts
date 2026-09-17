import type { Message, MessageEntity } from "grammy/types";

export namespace TelegramMessageText {
  export function withEntityLinks(
    message: Pick<Message, "caption" | "caption_entities" | "entities" | "text"> | undefined,
  ): string | null {
    const text = message?.text ?? message?.caption;
    if (text === undefined) return null;
    const entities = message?.text === undefined ? message?.caption_entities : message?.entities;
    const links = (entities ?? [])
      .flatMap((entity: MessageEntity) => {
        if (entity.type === "url") return [text.slice(entity.offset, entity.offset + entity.length)];
        if (entity.type === "text_link") return [entity.url];
        return [];
      })
      .filter((link, index, allLinks) => !text.includes(link) && allLinks.indexOf(link) === index);
    return links.length === 0 ? text : `${text}\nLINKS:\n${links.join("\n")}`;
  }
}

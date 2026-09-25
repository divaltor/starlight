import { expect, test } from "bun:test";
import { TelegramMessageText } from "@/handlers/telegram-message-text";

test("preserves hidden Telegram links once in entity order", () => {
  expect(
    TelegramMessageText.withEntityLinks({
      caption: "Instagram and source https://example.com",
      caption_entities: [
        { type: "text_link", offset: 0, length: 9, url: "https://instagram.com/reel/first" },
        { type: "url", offset: 21, length: 19 },
        { type: "text_link", offset: 0, length: 9, url: "https://instagram.com/reel/first" },
        { type: "text_link", offset: 0, length: 9, url: "https://video.example/second" },
      ],
    }),
  ).toBe(`Instagram and source https://example.com
LINKS:
https://instagram.com/reel/first
https://video.example/second`);
});

test("leaves text without new entity links unchanged", () => {
  expect(
    TelegramMessageText.withEntityLinks({
      entities: [
        { type: "url", offset: 6, length: 19 },
        { type: "text_link", offset: 0, length: 5, url: "https://example.com" },
      ],
      text: "Visit https://example.com",
    }),
  ).toBe("Visit https://example.com");
});

test("renders a poll-only message as its question with options", () => {
  expect(
    TelegramMessageText.withEntityLinks({
      poll: {
        options: [{ text: "0" }, { text: "2-3" }, { text: "4-7" }],
        question: "Сколько было половых партнёров?",
      },
    }),
  ).toBe("POLL: Сколько было половых партнёров?\nOPTIONS:\n- 0\n- 2-3\n- 4-7");
});

import { expect, test } from "bun:test";
import type { Message } from "grammy/types";
import { MessageReply } from "@/handlers/message-reply";

// Our product must treat a plain forum-topic message as a non-reply because
// Telegram attaches the topic-created service message as its reply target,
// otherwise Jev never runs in topics and quoted context shows topic metadata.
test("forum_topic_placeholder_reply_counts_as_no_reply", () => {
  const message = {
    message_id: 101,
    reply_to_message: { forum_topic_created: { name: "Films" }, message_id: 1 },
  } as Message;
  expect(MessageReply.actualReply(message)).toBeUndefined();
});

test("real_reply_inside_topic_stays_a_reply", () => {
  const reply = { from: { id: 7 }, message_id: 99, text: "Hi" } as Message;
  expect(MessageReply.actualReply({ message_id: 102, reply_to_message: reply } as Message)).toBe(reply);
});

// Our product must ignore bot mentions inside forwarded text because that text
// was authored by the original sender, otherwise every forward quoting the bot
// wakes it and replies to someone who never addressed it.
test("test_ignores_bot_name_when_forwarded", () => {
  const message = {
    forward_origin: { date: 1, sender_user: { first_name: "Vlad", id: 7, is_bot: false }, type: "user" },
    message_id: 103,
    text: "Старка мнение?",
  } as Message;
  expect(MessageReply.isAddressedToBot({ botId: 42, botUsername: "starka_bot", message })).toBe(false);
});

test("test_ignores_at_mention_when_forwarded", () => {
  const message = {
    forward_origin: { date: 1, sender_user: { first_name: "Vlad", id: 7, is_bot: false }, type: "user" },
    message_id: 104,
    text: "hey @starka_bot look",
  } as Message;
  expect(MessageReply.isAddressedToBot({ botId: 42, botUsername: "starka_bot", message })).toBe(false);
});

test("test_detects_bot_name_when_not_forwarded", () => {
  const message = { message_id: 105, text: "Старка мнение?" } as Message;
  expect(MessageReply.isAddressedToBot({ botId: 42, botUsername: "starka_bot", message })).toBe(true);
});

test("test_forwarded_reply_to_bot_does_not_trigger", () => {
  const message = {
    forward_origin: { date: 1, sender_user: { first_name: "Vlad", id: 7, is_bot: false }, type: "user" },
    message_id: 106,
    reply_to_message: { from: { first_name: "Bot", id: 42, is_bot: true }, message_id: 1 },
  } as Message;
  expect(MessageReply.isAddressedToBot({ botId: 42, botUsername: "starka_bot", message })).toBe(false);
});

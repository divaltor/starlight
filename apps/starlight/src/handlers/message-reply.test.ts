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

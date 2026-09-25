import { expect, test } from "bun:test";
import { Conversation } from "@/conversation/conversation";

// Our product must not let a trailing emoji become a sign-off, because delivered replies
// re-enter context and the model copies the ending into every later reply (topic 229223).
test.each([
  {
    expected: ["ну и катись"],
    name: "a recent reply already ended with one",
    recent: ["ok 💅"],
    replies: ["ну и катись 💅"],
  },
  { expected: ["ну и катись 💄"], name: "no recent reply ended with one", recent: ["ok"], replies: ["ну и катись 💄"] },
  {
    expected: ["раз 💄", "два"],
    name: "an earlier reply in the same run ended with one",
    recent: [],
    replies: ["раз 💄", "два 💅"],
  },
  { expected: ["💅 ну да"], name: "the emoji is not trailing", recent: ["ok 💅"], replies: ["💅 ну да"] },
  { expected: ["💅"], name: "the reply is only an emoji", recent: ["ok 💅"], replies: ["💅"] },
])("test_trailing_emoji_policy_when_$name", (input) => {
  const limited = Conversation.limitEmojiSignOffs(
    input.recent,
    input.replies.map((text) => ({ text, type: "text" as const })),
  );

  expect(limited.map((action) => (action.type === "text" ? action.text : action.type))).toEqual([...input.expected]);
});

test("test_trailing_emoji_is_allowed_again_once_it_leaves_the_recent_window", () => {
  const recent = ["old 💅", ...Array.from({ length: Conversation.emojiSignOffWindow }, () => "plain")];

  expect(Conversation.limitEmojiSignOffs(recent, [{ text: "снова 💅", type: "text" }])).toEqual([
    { text: "снова 💅", type: "text" },
  ]);
});

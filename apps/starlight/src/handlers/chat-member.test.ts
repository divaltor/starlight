import { expect, test } from "bun:test";

test("test_preserves_group_privacy_when_bot_membership_changes", async () => {
  const handler = await Bun.file(new URL("chat-member.ts", import.meta.url)).text();
  const update = handler.slice(handler.indexOf("update:"));

  expect(update).toStartWith("update:");
  expect(update).not.toContain("isPrivate");
});

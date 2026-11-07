import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { prisma } from "@starlight/utils";
import { Bot, BotError } from "grammy";
import { logger } from "@/logger";
import { attachChatMember } from "@/middlewares/session";
import type { Context } from "@/types";

const original = { findUnique: prisma.chatMember.findUnique };

afterEach(() => {
  mock.restore();
  Reflect.set(prisma.chatMember, "findUnique", original.findUnique);
});

test("test_propagates_downstream_error_once_when_chat_member_is_cached", async () => {
  spyOn(logger, "warn").mockImplementation(() => {});

  Reflect.set(
    prisma.chatMember,
    "findUnique",
    mock(
      async () =>
        await Promise.resolve({
          chatId: -100n,
          userId: "user",
          status: "member",
          supervisor: false,
          createdAt: new Date(0),
          updatedAt: new Date(120_000),
        }),
    ),
  );

  const testBot = new Bot<Context>("123:test", {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "Bot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });

  testBot.use(async (ctx, next) => {
    ctx.logger = logger;
    ctx.isSupervisor = false;
    ctx.user = {
      id: "user",
      telegramId: 42n,
      firstName: "User",
      lastName: null,
      username: null,
      isBot: false,
      isPublic: false,
      cookies: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    await next();
  });

  let nextCalls = 0;
  testBot.use(async (ctx, next) => {
    await attachChatMember(ctx, async () => {
      nextCalls++;
      await next();
    });
  });
  const downstreamError = new Error("Downstream handler failed");
  testBot.use(() => {
    throw downstreamError;
  });

  const failure = await testBot
    .handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -100, type: "supergroup", title: "Group" },
        from: { id: 42, is_bot: false, first_name: "User" },
        text: "command",
      },
    })
    .catch((cause: unknown) => cause);

  expect(failure instanceof BotError && failure.error).toBe(downstreamError);
  expect(nextCalls).toBe(1);
});

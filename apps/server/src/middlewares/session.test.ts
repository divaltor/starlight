import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { prisma } from "@starlight/utils";
import type { Prisma } from "@starlight/utils";
import { Bot } from "grammy";
import { logger } from "@/logger";
import { attachChatMember } from "@/middlewares/session";
import type { Context } from "@/types";
import { isAdminOrCreator } from "@/utils/auth";

const original = { findUnique: prisma.chatMember.findUnique, upsert: prisma.chatMember.upsert };

afterEach(() => {
  mock.restore();
  Reflect.set(prisma.chatMember, "findUnique", original.findUnique);
  Reflect.set(prisma.chatMember, "upsert", original.upsert);
});

test.each([
  { cached: "administrator", age: 59_999, telegram: "member", expected: "administrator", authorized: true },
  { cached: "creator", age: 59_999, telegram: "member", expected: "creator", authorized: true },
  { cached: "administrator", age: 60_000, telegram: "member", expected: "member", authorized: false },
  { cached: "creator", age: 60_001, telegram: "left", expected: "left", authorized: false },
  { cached: "administrator", age: 60_001, telegram: "restricted", expected: "restricted", authorized: false },
  { cached: "administrator", age: 60_001, telegram: "kicked", expected: "kicked", authorized: false },
  { cached: "member", age: 60_000, telegram: "administrator", expected: "administrator", authorized: true },
  { cached: null, age: 0, telegram: "creator", expected: "creator", authorized: true },
  { cached: "administrator", age: 60_000, telegram: null, expected: null, authorized: false },
  { cached: "creator", age: 60_000, telegram: null, expected: null, authorized: false },
])("test_bounds_cached_authority_when_%j", async (params) => {
  spyOn(Date, "now").mockReturnValue(120_000);
  spyOn(logger, "warn").mockImplementation(() => {});

  const member = {
    chatId: -100n,
    userId: "user",
    status: params.cached ?? "member",
    supervisor: false,
    createdAt: new Date(0),
    updatedAt: new Date(120_000 - params.age),
  };

  Reflect.set(
    prisma.chatMember,
    "findUnique",
    mock(async () => await Promise.resolve(params.cached === null ? null : member)),
  );
  Reflect.set(
    prisma.chatMember,
    "upsert",
    mock(
      async (args: Prisma.ChatMemberUpsertArgs) =>
        await Promise.resolve({ ...member, status: params.cached === null ? args.create.status : args.update.status }),
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
    client: {
      fetch: async () =>
        await Promise.resolve(
          Response.json(
            params.telegram === null
              ? { ok: false, error_code: 403, description: "Forbidden" }
              : {
                  ok: true,
                  result: { status: params.telegram, user: { id: 42, is_bot: false, first_name: "User" } },
                },
          ),
        ),
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
  testBot.use(attachChatMember);

  let result: { status: string | null; authorized: boolean } | undefined;
  testBot.use((ctx) => {
    result = { status: ctx.userChatMember?.status ?? null, authorized: isAdminOrCreator(ctx) };
  });

  await testBot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: -100, type: "supergroup", title: "Group" },
      from: { id: 42, is_bot: false, first_name: "User" },
      text: "command",
    },
  });

  expect(result).toEqual({ status: params.expected, authorized: params.authorized });
});

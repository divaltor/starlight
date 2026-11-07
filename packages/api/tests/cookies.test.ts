import { afterEach, expect, mock, test } from "bun:test";
import { call } from "@orpc/server";
import { CookieEncryption } from "@starlight/crypto";
import { prisma } from "@starlight/utils";
import type { User } from "@starlight/utils";
import { createContext } from "../src/context";
import { getUserProfile } from "../src/routers/profiles";

const original = {
  findUnique: prisma.user.findUnique,
  update: prisma.user.update,
};

const encryptionKey = "a".repeat(64);
const encryptionSalt = "cookie-test-salt";

afterEach(() => {
  Reflect.set(prisma.user, "findUnique", original.findUnique);
  Reflect.set(prisma.user, "update", original.update);
});

test.each([
  { state: "missing", cookies: null, hasValidCookies: false },
  { state: "empty", cookies: "", hasValidCookies: false },
  { state: "undecryptable", cookies: "a".repeat(160), hasValidCookies: false },
  {
    state: "decryptable",
    cookies: new CookieEncryption(encryptionKey, encryptionSalt).encrypt("[]", "123"),
    hasValidCookies: true,
  },
])("test_profile_reads_preserve_stored_cookies_when_$state", async (params) => {
  const storedUser: User = {
    id: "user",
    telegramId: 123n,
    firstName: "User",
    lastName: null,
    username: "user",
    isBot: false,
    isPublic: false,
    cookies: params.cookies,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  Reflect.set(
    prisma.user,
    "findUnique",
    mock(async () => await Promise.resolve({ ...storedUser })),
  );
  Reflect.set(
    prisma.user,
    "update",
    mock(async (args: { data: Pick<User, "cookies"> }) => await Promise.resolve(Object.assign(storedUser, args.data))),
  );

  const profile = await call(getUserProfile, undefined, {
    context: createContext({
      request: new Request("https://example.com/api/rpc/profiles/get", {
        headers: {
          Authorization: new URLSearchParams({
            auth_date: "1",
            hash: "test",
            signature: "test",
            user: JSON.stringify({ id: 123, first_name: "User" }),
          }).toString(),
        },
      }),
      config: {
        baseCdnUrl: "https://example.com",
        botToken: "123:test",
        cookieEncryptionKey: encryptionKey,
        cookieEncryptionSalt: encryptionSalt,
        embeddingsEnabled: false,
        nodeEnv: "development",
      },
      generateTextEmbedding: async () => await Promise.resolve(null),
    }),
  });

  expect(profile.hasValidCookies).toBe(params.hasValidCookies);
  expect(storedUser.cookies).toBe(params.cookies);
});

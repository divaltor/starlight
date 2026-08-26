import { ORPCError } from "@orpc/client";
import { CookieEncryption } from "@starlight/crypto";
import { prisma } from "@starlight/utils";
import { z } from "zod";
import type { Context } from "../context";
import { protectedProcedure } from "../middlewares/auth";
import type { AuthContext } from "../middlewares/auth";

const cookiesSchema = z.object({
  cookies: z.string(),
});

export const saveCookies = protectedProcedure.input(cookiesSchema).handler(async ({ input, context }) => {
  if (!(context.user && context.databaseUserId)) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Unauthorized",
      status: 401,
    });
  }

  // Attempt to decode cookies; accept any non-empty string
  if (!input.cookies?.trim()) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Invalid cookies",
      status: 400,
    });
  }

  // Encrypt and store under telegramId scoped key
  const encryptedCookies = new CookieEncryption(
    context.config.cookieEncryptionKey,
    context.config.cookieEncryptionSalt,
  ).encrypt(input.cookies, context.user.id.toString());

  await prisma.user.update({
    where: {
      id: context.databaseUserId,
    },
    data: {
      cookies: encryptedCookies,
    },
  });
});

export const verifyCookies = async ({ context }: { context: AuthContext & Context }) => {
  try {
    if (!(context.user && context.databaseUserId)) {
      return { hasValidCookies: false };
    }

    const user = await prisma.user.findUnique({
      where: {
        id: context.databaseUserId,
      },
      select: {
        cookies: true,
      },
    });

    const storedCookies = user?.cookies;

    if (!storedCookies) {
      return { hasValidCookies: false };
    }

    try {
      new CookieEncryption(context.config.cookieEncryptionKey, context.config.cookieEncryptionSalt).safeDecrypt(
        storedCookies,
        context.user.id.toString(),
      );
    } catch {
      await prisma.user.update({
        where: {
          id: context.databaseUserId,
        },
        data: {
          cookies: null,
        },
      });
      return { hasValidCookies: false };
    }

    return { hasValidCookies: true };
  } catch {
    return {
      hasValidCookies: false,
    };
  }
};

export const deleteCookies = protectedProcedure.handler(async ({ context }) => {
  if (!context.databaseUserId) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Unauthorized",
      status: 401,
    });
  }

  await prisma.user.update({
    where: {
      id: context.databaseUserId,
    },
    data: {
      cookies: null,
    },
  });
});

import { CookieEncryption } from "@starlight/crypto";
import { prisma } from "@starlight/utils";
import env from "../env";
import { PixivAdapter } from "./pixiv";
import { createPixivCredentialService } from "./pixiv-credential-core";

const PURPOSE = "provider:pixiv:refresh-token";
const encryption = new CookieEncryption(env.COOKIE_ENCRYPTION_KEY, env.COOKIE_ENCRYPTION_SALT);

export const encryptPixivToken = (token: string, userId: string) => encryption.encryptScoped(token, userId, PURPOSE);

export const withPixivLock = <T>(userId: string, operation: () => Promise<T>) => {
  const lockKey = `pixiv:${userId}`;
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      return operation();
    },
    { timeout: 120_000 },
  );
};

export const withPixivClient = createPixivCredentialService({
  withLock: withPixivLock,
  find: (userId) =>
    prisma.providerCredential.findUnique({
      where: { userId_provider: { userId, provider: "pixiv" } },
    }),
  decryptScoped: (secret, userId) => encryption.decryptScoped(secret, userId, PURPOSE),
  decryptLegacy: (secret, userId) => encryption.decrypt(secret, userId),
  connect: PixivAdapter.connect,
  encrypt: encryptPixivToken,
  updateMatching: (userId, encryptedSecret, replacement) =>
    prisma.providerCredential.updateMany({
      where: {
        userId,
        provider: "pixiv",
        credentialType: "refresh_token",
        encryptedSecret,
      },
      data: { encryptedSecret: replacement },
    }),
});

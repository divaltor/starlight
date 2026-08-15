import { CookieEncryption } from "@starlight/crypto";
import { env, prisma } from "@starlight/utils";
import { createTwitterCredentialService } from "./twitter-credential-core";

export { createTwitterCredentialService } from "./twitter-credential-core";

const TWITTER_COOKIES_PURPOSE = "provider:twitter:cookies:v1";
const encryption = new CookieEncryption(env.COOKIE_ENCRYPTION_KEY, env.COOKIE_ENCRYPTION_SALT);

const twitterCredentials = createTwitterCredentialService({
	find: (userId) =>
		prisma.providerCredential.findUnique({
			where: { userId_provider: { userId, provider: "twitter" } },
			select: {
				credentialType: true,
				encryptedSecret: true,
				provider: true,
				user: { select: { telegramId: true } },
			},
		}),
	decrypt: (secret, userId, telegramId) =>
		encryption.decryptScopedOrLegacy(secret, userId, TWITTER_COOKIES_PURPOSE, telegramId),
	encrypt: (cookies, userId) => encryption.encryptScoped(cookies, userId, TWITTER_COOKIES_PURPOSE),
	updateMatching: (userId, encryptedSecret, replacement) =>
		prisma.providerCredential.updateMany({
			where: { userId, provider: "twitter", credentialType: "cookies", encryptedSecret },
			data: { encryptedSecret: replacement },
		}),
	deleteMatching: (userId, encryptedSecret) =>
		prisma.providerCredential.deleteMany({
			where: { userId, provider: "twitter", credentialType: "cookies", encryptedSecret },
		}),
});

export const encryptTwitterCookies = (cookies: string, userId: string) =>
	encryption.encryptScoped(cookies, userId, TWITTER_COOKIES_PURPOSE);

export const getTwitterCookies = (userId: string) => twitterCredentials.get(userId);

export const hasTwitterCookies = async (userId: string) =>
	Boolean(await twitterCredentials.get(userId));

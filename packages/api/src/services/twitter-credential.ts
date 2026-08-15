import { CookieEncryption } from "@starlight/crypto";
import { env, prisma } from "@starlight/utils";

const TWITTER_COOKIES_PURPOSE = "provider:twitter:cookies:v1";
const encryption = new CookieEncryption(env.COOKIE_ENCRYPTION_KEY, env.COOKIE_ENCRYPTION_SALT);

export const encryptTwitterCookies = (cookies: string, userId: string) =>
	encryption.encryptScoped(cookies, userId, TWITTER_COOKIES_PURPOSE);

export const hasTwitterCookies = async (userId: string) => {
	const credential = await prisma.providerCredential.findUnique({
		where: { userId_provider: { userId, provider: "twitter" } },
		select: { credentialType: true },
	});
	return credential?.credentialType === "cookies";
};

export const getTwitterCookies = async (userId: string, telegramId: string) => {
	const credential = await prisma.providerCredential.findUnique({
		where: { userId_provider: { userId, provider: "twitter" } },
	});
	if (!credential || credential.credentialType !== "cookies") {
		return;
	}

	const decrypted = encryption.decryptScopedOrLegacy(
		credential.encryptedSecret,
		userId,
		TWITTER_COOKIES_PURPOSE,
		telegramId,
	);
	if (decrypted.usedLegacyEncryption) {
		await prisma.providerCredential.update({
			where: { userId_provider: { userId, provider: "twitter" } },
			data: { encryptedSecret: encryptTwitterCookies(decrypted.data, userId) },
		});
	}

	return decrypted.data;
};

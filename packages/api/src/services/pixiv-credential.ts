import { CookieEncryption } from "@starlight/crypto";
import { env, prisma } from "@starlight/utils";
import { PixivAdapter } from "./pixiv";
import { executePixivOperation } from "./pixiv-credential-operation";

const PURPOSE = "provider:pixiv:refresh-token";
const encryption = new CookieEncryption(env.COOKIE_ENCRYPTION_KEY, env.COOKIE_ENCRYPTION_SALT);

export const encryptPixivToken = (token: string, userId: string) =>
	encryption.encryptScoped(token, userId, PURPOSE);

export const withPixivLock = async <T>(userId: string, operation: () => Promise<T>) => {
	return prisma.$transaction(
		async (transaction) => {
			await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pixiv:${userId}`}, 0))`;
			return operation();
		},
		{ timeout: 120_000 },
	);
};

export const withPixivClient = async <T>(
	userId: string,
	operation: (client: PixivAdapter) => Promise<T>,
) =>
	withPixivLock(userId, async () => {
		const credential = await prisma.providerCredential.findUnique({
			where: { userId_provider: { userId, provider: "pixiv" } },
		});
		if (!credential) {
			return;
		}
		let token: string;
		let migrated = false;
		try {
			token = encryption.decryptScoped(credential.encryptedSecret, userId, PURPOSE);
		} catch {
			token = encryption.decrypt(credential.encryptedSecret, userId);
			migrated = true;
		}
		const client = await PixivAdapter.connect(token);
		return executePixivOperation({
			client,
			originalToken: token,
			migrated,
			operation,
			persistToken: async (refreshToken) => {
				await prisma.providerCredential.update({
					where: { userId_provider: { userId, provider: "pixiv" } },
					data: {
						encryptedSecret: encryptPixivToken(refreshToken, userId),
					},
				});
			},
		});
	});

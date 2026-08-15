import { normalizeTwitterCookies } from "./twitter-cookies";

interface TwitterCredential {
	credentialType: string;
	encryptedSecret: string;
	provider: string;
	user: { telegramId: bigint };
}

export const createTwitterCredentialService = (dependencies: {
	decrypt: (
		secret: string,
		userId: string,
		telegramId: string,
	) => {
		data: string;
		usedLegacyEncryption: boolean;
	};
	deleteMatching: (userId: string, encryptedSecret: string) => Promise<{ count: number }>;
	encrypt: (cookies: string, userId: string) => string;
	find: (userId: string) => Promise<TwitterCredential | null>;
	updateMatching: (
		userId: string,
		encryptedSecret: string,
		replacement: string,
	) => Promise<{ count: number }>;
}) => {
	const read = async (userId: string, retryOnCasLoss: boolean): Promise<string | undefined> => {
		const credential = await dependencies.find(userId);
		if (
			!credential ||
			credential.provider !== "twitter" ||
			credential.credentialType !== "cookies"
		) {
			return;
		}
		const originalEncryptedSecret = credential.encryptedSecret;

		let decrypted: { data: string; usedLegacyEncryption: boolean };
		let normalizedCookies: string;
		try {
			decrypted = dependencies.decrypt(
				originalEncryptedSecret,
				userId,
				credential.user.telegramId.toString(),
			);
			normalizedCookies = normalizeTwitterCookies(decrypted.data);
		} catch {
			const deleted = await dependencies.deleteMatching(userId, originalEncryptedSecret);
			if (deleted.count === 0 && retryOnCasLoss) {
				return read(userId, false);
			}
			return;
		}

		if (decrypted.usedLegacyEncryption) {
			const updated = await dependencies.updateMatching(
				userId,
				originalEncryptedSecret,
				dependencies.encrypt(normalizedCookies, userId),
			);
			if (updated.count === 0 && retryOnCasLoss) {
				return read(userId, false);
			}
			if (updated.count === 0) {
				return;
			}
		}

		return normalizedCookies;
	};

	return {
		get: (userId: string) => read(userId, true),
	};
};

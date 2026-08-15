import { parseTwitterCookies } from "./twitter-cookies";

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

		let decrypted: { data: string; usedLegacyEncryption: boolean };
		try {
			decrypted = dependencies.decrypt(
				credential.encryptedSecret,
				userId,
				credential.user.telegramId.toString(),
			);
			parseTwitterCookies(decrypted.data);
		} catch {
			const deleted = await dependencies.deleteMatching(userId, credential.encryptedSecret);
			if (deleted.count === 0 && retryOnCasLoss) {
				return read(userId, false);
			}
			return;
		}

		if (decrypted.usedLegacyEncryption) {
			const updated = await dependencies.updateMatching(
				userId,
				credential.encryptedSecret,
				dependencies.encrypt(decrypted.data, userId),
			);
			if (updated.count === 0 && retryOnCasLoss) {
				return read(userId, false);
			}
			if (updated.count === 0) {
				return;
			}
		}

		return decrypted.data;
	};

	return {
		get: (userId: string) => read(userId, true),
	};
};

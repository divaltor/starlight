export const createPixivCredentialService =
	<Client extends { refreshToken: string }>(dependencies: {
		connect: (token: string) => Promise<Client>;
		decryptLegacy: (secret: string, userId: string) => string;
		decryptScoped: (secret: string, userId: string) => string;
		encrypt: (token: string, userId: string) => string;
		find: (userId: string) => Promise<{
			credentialType: string;
			encryptedSecret: string;
		} | null>;
		updateMatching: (
			userId: string,
			encryptedSecret: string,
			replacement: string,
		) => Promise<{ count: number }>;
		withLock: <T>(userId: string, operation: () => Promise<T>) => Promise<T>;
	}) =>
	async <T>(userId: string, operation: (client: Client) => Promise<T>) =>
		dependencies.withLock(userId, async () => {
			const credential = await dependencies.find(userId);
			if (!credential || credential.credentialType !== "refresh_token") {
				return;
			}

			let token: string;
			let migrated = false;
			try {
				token = dependencies.decryptScoped(credential.encryptedSecret, userId);
			} catch {
				token = dependencies.decryptLegacy(credential.encryptedSecret, userId);
				migrated = true;
			}

			const client = await dependencies.connect(token);
			if (migrated || client.refreshToken !== token) {
				const updated = await dependencies.updateMatching(
					userId,
					credential.encryptedSecret,
					dependencies.encrypt(client.refreshToken, userId),
				);
				if (updated.count === 0) {
					throw new Error("Pixiv credential changed during token rotation");
				}
			}

			return operation(client);
		});

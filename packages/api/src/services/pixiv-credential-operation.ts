const captureOutcome = async <TResult>(operation: () => Promise<TResult>) => {
	try {
		return { success: true, value: await operation() } as const;
	} catch (error) {
		return { success: false, error } as const;
	}
};

export const executePixivOperation = async <
	TClient extends { readonly refreshToken: string },
	TResult,
>({
	client,
	originalToken,
	migrated,
	operation,
	persistToken,
}: {
	client: TClient;
	originalToken: string;
	migrated: boolean;
	operation: (client: TClient) => Promise<TResult>;
	persistToken: (token: string) => Promise<void>;
}) => {
	const outcome = await captureOutcome(() => operation(client));
	let persistenceOutcome:
		| { success: true }
		| { success: false; error: unknown } = { success: true };
	try {
		if (!outcome.success) {
			throw outcome.error;
		}
	} finally {
		if (migrated || client.refreshToken !== originalToken) {
			try {
				await persistToken(client.refreshToken);
			} catch (error) {
				persistenceOutcome = { success: false, error };
			}
		}
	}
	if (!persistenceOutcome.success) {
		throw persistenceOutcome.error;
	}
	return outcome.value;
};

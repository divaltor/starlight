import { env, getPrismaClient } from "@repo/utils";
import { createMiddleware } from "@tanstack/react-start";
import { getHeader } from "@tanstack/react-start/server";
import { parse, validate } from "@telegram-apps/init-data-node";

export interface AuthContext {
	user?: {
		id: number;
		first_name: string;
		last_name?: string;
		username?: string;
		language_code?: string;
		is_premium?: boolean;
	};
}

export const authMiddleware = createMiddleware().server(async ({ next }) => {
	const auth = getHeader("Authorization");

	if (!auth) {
		throw new Error("Unauthorized: No init data provided");
	}

	// On dev, we don't need to validate the init data
	if (env.ENVIRONMENT === "prod") {
		try {
			validate(auth, env.BOT_TOKEN);
		} catch {
			throw new Error("Invalid init data");
		}
	}

	const parsedData = parse(auth);

	if (!parsedData.user) {
		throw new Error("Invalid init data: No user found");
	}

	const prisma = getPrismaClient();

	const databaseUser = await prisma.user.findUnique({
		where: { telegramId: parsedData.user.id },
		select: {
			id: true,
		},
	});

	// Like impossible to happen because if user is not in the database, they won't be able to use the bot
	if (!databaseUser) {
		throw new Error("User not found");
	}

	return next({
		context: {
			user: parsedData.user,
			databaseUserId: databaseUser.id,
			queryId: parsedData.query_id,
		},
	});
});

export const optionalAuthMiddleware = createMiddleware().server(
	async ({ next }) => {
		let authContext: AuthContext | null = null;

		const auth = getHeader("Authorization");

		if (auth) {
			try {
				// On dev, we don't need to validate the init data
				if (env.ENVIRONMENT === "prod") {
					validate(auth, env.BOT_TOKEN);
				}

				const parsedData = parse(auth);

				if (parsedData.user) {
					authContext = {
						user: parsedData.user,
					};
				}
			} catch {
				// Ignore auth errors for optional auth
			}
		}

		return next({ context: { user: authContext?.user } });
	}
);

export function createAuthError(message: string) {
	return { error: message };
}

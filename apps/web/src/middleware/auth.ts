import { env, getPrismaClient } from "@repo/utils";
import { createMiddleware } from "@tanstack/react-start";
import { parse, validate } from "@telegram-apps/init-data-node";
import { z } from "zod";

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

const authDataSchema = z.object({
	initData: z.string().optional(),
});

export const authMiddleware = createMiddleware()
	.validator(authDataSchema)
	.server(async ({ next, data }) => {
		if (!data.initData) {
			throw new Error("Unauthorized: No init data provided");
		}

		// On dev, we don't need to validate the init data
		if (env.ENVIRONMENT === "prod") {
			try {
				validate(data.initData, env.BOT_TOKEN);
			} catch (error) {
				throw new Error("Invalid init data");
			}
		}

		const parsedData = parse(data.initData);

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
			context: { user: parsedData.user, databaseUserId: databaseUser.id },
		});
	});

export const optionalAuthMiddleware = createMiddleware()
	.validator(authDataSchema)
	.server(async ({ next, data }) => {
		let authContext: AuthContext | null = null;

		if (data.initData) {
			try {
				// On dev, we don't need to validate the init data
				if (env.ENVIRONMENT === "prod") {
					validate(data.initData, env.BOT_TOKEN);
				}

				const parsedData = parse(data.initData);

				if (parsedData.user) {
					authContext = {
						user: parsedData.user,
					};
				}
			} catch (error) {
				// Ignore auth errors for optional auth
			}
		}

		return next({ context: { user: authContext?.user } });
	});

export function createAuthError(message: string) {
	return { error: message };
}

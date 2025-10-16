import { ORPCError } from "@orpc/client";
import { env, prisma } from "@starlight/utils";
import { parse, validate } from "@telegram-apps/init-data-node";
import { o, publicProcedure } from "../index";

export type AuthContextUser = {
	id: number;
	first_name: string;
	last_name?: string;
	username?: string;
	language_code?: string;
	is_premium?: boolean;
};

export type AuthContext = {
	user?: AuthContextUser;
	databaseUserId?: string;
	queryId?: string;
};

export const authMiddleware = o.middleware(async ({ next, context }) => {
	const auth = context.request.headers.authorization;

	if (!auth) {
		throw new ORPCError("UNAUTHORIZED", {
			message: "Unauthorized: No init data provided",
			status: 401,
		});
	}

	if (env.ENVIRONMENT === "prod") {
		try {
			validate(auth, env.BOT_TOKEN);
		} catch {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid init data",
				status: 400,
			});
		}
	}

	const parsedData = parse(auth);

	if (!parsedData.user) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid init data: No user found",
			status: 400,
		});
	}

	const databaseUser = await prisma.user.findUnique({
		where: { telegramId: parsedData.user.id },
		select: { id: true },
	});

	if (!databaseUser) {
		throw new ORPCError("NOT_FOUND", {
			message: "User not found",
			status: 404,
		});
	}

	return next({
		context: {
			...context,
			user: parsedData.user,
			databaseUserId: databaseUser.id,
			queryId: parsedData.query_id,
		},
	});
});

export const optionalAuthMiddleware = o.middleware(({ next, context }) => {
	let user: AuthContextUser | undefined;

	const auth = context.request.headers.authorization;

	if (auth) {
		try {
			if (env.ENVIRONMENT === "prod") {
				validate(auth, env.BOT_TOKEN);
			}

			const parsedData = parse(auth);
			if (parsedData.user) {
				user = parsedData.user;
			}
			// biome-ignore lint/suspicious/noEmptyBlockStatements: Ignore auth errors for optional auth
		} catch {}
	}

	return next({
		context: {
			...context,
			user,
		},
	});
});

export const protectedProcedure = publicProcedure.use(authMiddleware);
export const maybeAuthProcedure = publicProcedure.use(optionalAuthMiddleware);

import { env } from "@repo/utils";
import { parse, validate } from "@telegram-apps/init-data-node";

export interface AuthContext {
	userId: number;
	user: {
		id: number;
		first_name: string;
		last_name?: string;
		username?: string;
		language_code?: string;
		is_premium?: boolean;
	};
}

export interface AuthVerificationResult {
	success: true;
	auth: AuthContext;
}

export interface AuthVerificationError {
	success: false;
	error: string;
}

export type AuthVerificationResponse =
	| AuthVerificationResult
	| AuthVerificationError;

export async function verifyAuth(
	initData?: string,
): Promise<AuthVerificationResponse> {
	if (!initData) {
		return {
			success: false,
			error: "Unauthorized: No init data provided",
		};
	}

	// On dev, we don't need to validate the init data
	if (env.ENVIRONMENT === "prod") {
		try {
			validate(initData, env.BOT_TOKEN);
		} catch (error) {
			return {
				success: false,
				error: "Invalid init data",
			};
		}
	}

	const parsedData = parse(initData);

	if (!parsedData.user) {
		return {
			success: false,
			error: "Invalid init data: No user found",
		};
	}

	const authContext: AuthContext = {
		userId: parsedData.user.id,
		user: parsedData.user,
	};

	return {
		success: true,
		auth: authContext,
	};
}

export async function verifyOptionalAuth(
	initData?: string,
): Promise<AuthContext | null> {
	if (!initData) {
		return null;
	}

	try {
		// On dev, we don't need to validate the init data
		if (env.ENVIRONMENT === "prod") {
			validate(initData, env.BOT_TOKEN);
		}

		const parsedData = parse(initData);

		if (parsedData.user) {
			return {
				userId: parsedData.user.id,
				user: parsedData.user,
			};
		}
	} catch (error) {
		// Ignore auth errors for optional auth
	}

	return null;
}

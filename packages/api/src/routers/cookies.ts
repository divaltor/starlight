import { ORPCError } from "@orpc/client";
import { prisma } from "@starlight/utils";
import { z } from "zod";
import { type AuthContext, protectedProcedure } from "../middlewares/auth";
import { encryptTwitterCookies, getTwitterCookies } from "../services/twitter-credential";

const cookiesSchema = z.object({
	cookies: z.string(),
});

export const saveCookies = protectedProcedure
	.input(cookiesSchema)
	.handler(async ({ input, context }) => {
		if (!(context.user && context.databaseUserId)) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Unauthorized",
				status: 401,
			});
		}

		// Attempt to decode cookies; accept any non-empty string
		if (!input.cookies?.trim()) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid cookies",
				status: 400,
			});
		}

		const userId = context.databaseUserId;
		const encryptedCookies = encryptTwitterCookies(input.cookies, userId);

		await prisma.providerCredential.upsert({
			where: { userId_provider: { userId, provider: "twitter" } },
			create: {
				userId,
				provider: "twitter",
				credentialType: "cookies",
				encryptedSecret: encryptedCookies,
			},
			update: {
				credentialType: "cookies",
				encryptedSecret: encryptedCookies,
			},
		});
	});

export const verifyCookies = async ({ context }: { context: AuthContext }) => {
	try {
		if (!(context.user && context.databaseUserId)) {
			return { hasValidCookies: false };
		}

		const cookies = await getTwitterCookies(context.databaseUserId);

		if (!cookies) {
			return { hasValidCookies: false };
		}

		return { hasValidCookies: true };
	} catch {
		return {
			hasValidCookies: false,
		};
	}
};

export const deleteCookies = protectedProcedure.handler(async ({ context }) => {
	if (!context.databaseUserId) {
		throw new ORPCError("UNAUTHORIZED", {
			message: "Unauthorized",
			status: 401,
		});
	}

	await prisma.providerCredential.deleteMany({
		where: { userId: context.databaseUserId, provider: "twitter" },
	});
});

import { ORPCError } from "@orpc/client";
import { prisma } from "@starlight/utils";
import { z } from "zod";
import { protectedProcedure } from "../middlewares/auth";
import { PixivAdapter } from "../services/pixiv";
import { encryptPixivToken, withPixivLock } from "../services/pixiv-credential";

export const savePixivCredential = protectedProcedure
	.input(z.object({ refreshToken: z.string().trim().min(20) }))
	.handler(async ({ input, context }) => {
		const userId = context.databaseUserId;
		await withPixivLock(userId, async () => {
			let client: PixivAdapter;
			try {
				client = await PixivAdapter.connect(input.refreshToken);
			} catch {
				throw new ORPCError("BAD_REQUEST", {
					message: "Invalid Pixiv refresh token",
					status: 400,
				});
			}
			await prisma.providerCredential.upsert({
				where: { userId_provider: { userId, provider: "pixiv" } },
				create: {
					userId,
					provider: "pixiv",
					credentialType: "refresh_token",
					externalUserId: client.externalUserId,
					encryptedSecret: encryptPixivToken(client.refreshToken, userId),
				},
				update: {
					credentialType: "refresh_token",
					externalUserId: client.externalUserId,
					encryptedSecret: encryptPixivToken(client.refreshToken, userId),
				},
			});
		});
		return { success: true };
	});

export const deletePixivCredential = protectedProcedure.handler(async ({ context }) => {
	const userId = context.databaseUserId;
	await withPixivLock(userId, async () => {
		await prisma.providerCredential.deleteMany({
			where: { userId, provider: "pixiv" },
		});
	});
	return { success: true };
});

export const setPixivPrivateBookmarks = protectedProcedure
	.input(z.object({ enabled: z.boolean() }))
	.handler(async ({ input, context }) => {
		await prisma.user.update({
			where: { id: context.databaseUserId },
			data: { pixivIncludePrivate: input.enabled },
		});
		return { success: true };
	});

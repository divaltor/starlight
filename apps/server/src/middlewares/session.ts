import { prisma, toUniqueId } from "@starlight/utils";
import type { NextFunction } from "grammy";
import { s3 } from "@/storage";
import type { Context } from "@/types";

export async function attachUser(ctx: Context, next: NextFunction) {
	if (!ctx.from) {
		ctx.logger.warn("User not found, skipping session attachment.");
		return await next();
	}

	const user = await prisma.user.upsert({
		where: {
			telegramId: ctx.from.id,
		},
		create: {
			telegramId: ctx.from.id,
			username: ctx.from.username,
			firstName: ctx.from.first_name,
			lastName: ctx.from.last_name,
			isBot: ctx.from.is_bot,
		},
		update: {
			username: ctx.from.username,
			firstName: ctx.from.first_name,
			lastName: ctx.from.last_name,
		},
	});

	ctx.user = user;

	await next();
}

export async function attachChat(ctx: Context, next: NextFunction) {
	if (!ctx.chat) {
		return await next();
	}

	const existingChat = await prisma.chat.findUnique({
		where: {
			id: ctx.chat.id,
		},
		select: {
			id: true,
		},
	});

	let chatPhotoData: {
		photoThumbnail?: string;
		photoBig?: string;
	} = {};

	if (!existingChat) {
		try {
			const fullChatInfo = await ctx.api.getChat(ctx.chat.id);

			if (fullChatInfo.photo) {
				const [thumbnail, big] = await Promise.all([
					ctx.api.getFile(fullChatInfo.photo.small_file_id),
					ctx.api.getFile(fullChatInfo.photo.big_file_id),
				]);

				const [bigFile, thumbnailFile] = await Promise.all([
					big.download(),
					thumbnail.download(),
				]);

				const chatUniqueId = toUniqueId(ctx.chat.id);
				const bigPath = `chats/${chatUniqueId}/big.jpg`;
				const thumbnailPath = `chats/${chatUniqueId}/thumbnail.jpg`;

				await Promise.all([
					s3.write(bigPath, Bun.file(bigFile)),
					s3.write(thumbnailPath, Bun.file(thumbnailFile)),
				]);

				chatPhotoData = {
					photoThumbnail: thumbnailPath,
					photoBig: bigPath,
				};
			}
		} catch (error) {
			ctx.logger.warn(
				{ error, chatId: ctx.chat.id },
				"Failed to save chat photo."
			);
		}
	}

	const chat = await prisma.chat.upsert({
		where: {
			id: ctx.chat.id,
		},
		create: {
			id: ctx.chat.id,
			title: ctx.chat.title,
			username: ctx.chat.username,
			...chatPhotoData,
		},
		update: {
			title: ctx.chat.title,
			username: ctx.chat.username,
		},
	});

	ctx.userChat = chat;

	await next();
}

export async function attachChatMember(ctx: Context, next: NextFunction) {
	if (
		!(ctx.chat && ctx.from && ctx.user) ||
		(ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")
	) {
		return await next();
	}

	const chatId = BigInt(ctx.chat.id);

	try {
		const existingMember = await prisma.chatMember.findUnique({
			where: {
				chatId_userId: {
					chatId,
					userId: ctx.user.id,
				},
			},
		});

		if (existingMember) {
			ctx.userChatMember = existingMember;
			return await next();
		}

		const telegramMember = await ctx.api.getChatMember(
			ctx.chat.id,
			ctx.from.id
		);

		ctx.userChatMember = await prisma.chatMember.upsert({
			where: {
				chatId_userId: {
					chatId,
					userId: ctx.user.id,
				},
			},
			create: {
				chatId,
				userId: ctx.user.id,
				status: telegramMember.status,
			},
			update: {
				status: telegramMember.status,
			},
		});
	} catch (error) {
		ctx.logger.warn(
			{
				error,
				chatId: ctx.chat.id,
				userId: ctx.from.id,
			},
			"Failed to attach chat member."
		);
	}

	await next();
}
